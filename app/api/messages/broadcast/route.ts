import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { authenticateRequest, isAdminEmail } from '@/lib/apiAuth'
import {
  NOTIFICATION_FROM,
  NOTIFICATION_SUBJECT,
  buildNotificationEmail,
} from '@/lib/messageNotify'

/**
 * Tier broadcast email notification, admin only.
 *
 * Replaces a browser loop that fired one unawaited request per recipient —
 * 114 concurrent Resend calls whose { data, error } was never inspected.
 * About 19 of 114 emails landed and nothing recorded it.
 *
 * The delivery plan is frozen once, before any Resend call: recipients are
 * resolved, payloads rendered, and both stored per batch. Every retry replays
 * the stored payload under the stored idempotency key, so a crash between
 * "Resend accepted" and "database updated" cannot double-send. Recipients are
 * never re-resolved, because a single membership change shifts one recipient
 * across the 100/13 boundary and would re-email them.
 *
 * The database enforces this: service_role has UPDATE on only
 * status/attempts/last_error/submitted_at/completed_at, so every .update()
 * below names those columns and nothing else.
 */

export const maxDuration = 60

const resend = new Resend(process.env.RESEND_API_KEY)

const MAX_BATCH_SIZE = 100
const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 1000
const LEASE_MS = 2 * 60 * 1000

/**
 * How long a batch may sit in `submitting` before replay stops being safe.
 * Deliberately half of Resend's ~24h idempotency retention: being early costs
 * a manual review, being late duplicates a broadcast to paying customers.
 */
const SAFE_REPLAY_WINDOW_MS = 12 * 60 * 60 * 1000

const ALLOWED_TIERS = ['free', 'premium', 'ultimate'] as const
type Tier = (typeof ALLOWED_TIERS)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const RETRYABLE = new Set(['rate_limit_exceeded', 'internal_server_error', 'application_error'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type BatchRow = {
  id: string
  batch_index: number
  payload: unknown
  idempotency_key: string
  recipient_count: number
  status: string
  attempts: number
  submitted_at: string | null
}

function serviceClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) {
    console.error('Broadcast: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return null
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

const PARENT_FIELDS =
  'id, attempted, succeeded, failed, status, planned_batches, lease_owner, lease_expires_at'

async function loadBatches(admin: SupabaseClient, broadcastId: string): Promise<BatchRow[]> {
  const { data, error } = await admin
    .from('email_broadcast_batches')
    .select('id, batch_index, payload, idempotency_key, recipient_count, status, attempts, submitted_at')
    .eq('broadcast_id', broadcastId)
    .order('batch_index', { ascending: true })
  if (error) throw new Error(`batch load failed: ${error.message}`)
  return (data ?? []) as BatchRow[]
}

/** Aggregates are derived from batch rows, never from in-memory counters. */
function aggregate(batches: BatchRow[]) {
  let succeeded = 0
  let failed = 0
  let uncertain = 0
  let outstanding = 0
  for (const b of batches) {
    if (b.status === 'sent') succeeded += b.recipient_count
    else if (b.status === 'failed') failed += b.recipient_count
    else if (b.status === 'uncertain') uncertain += b.recipient_count
    else outstanding += b.recipient_count
  }
  const status =
    outstanding > 0
      ? 'sending'
      : failed === 0 && uncertain === 0
        ? 'completed'
        : succeeded === 0 && uncertain === 0
          ? 'failed'
          : 'partial'
  return { succeeded, failed, uncertain, outstanding, status }
}

export async function POST(request: NextRequest) {
  const admin = null as SupabaseClient | null
  let claimed: { admin: SupabaseClient; broadcastId: string } | null = null

  try {
    // ---- 1-3. authenticate, authorize, validate -----------------------------
    const auth = await authenticateRequest()
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isAdminEmail(auth.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    let body: any = {}
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const tier = String(body?.tier ?? '')
    const requestKey = String(body?.requestKey ?? '')
    const subject = String(body?.subject ?? '').trim()
    const message = String(body?.message ?? '')

    if (!ALLOWED_TIERS.includes(tier as Tier))
      return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
    if (!UUID_RE.test(requestKey))
      return NextResponse.json({ error: 'Invalid request key' }, { status: 400 })
    if (!subject || !message.trim())
      return NextResponse.json({ error: 'Subject and message are required' }, { status: 400 })

    const db = serviceClient()
    if (!db) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })

    // ---- 4. resolve or create the parent by request_key ---------------------
    let { data: parent } = await db
      .from('email_broadcasts')
      .select(PARENT_FIELDS)
      .eq('request_key', requestKey)
      .maybeSingle()

    if (!parent) {
      const { data: created, error: insertError } = await db
        .from('email_broadcasts')
        .insert({ request_key: requestKey, tier, subject, created_by: auth.userId, status: 'pending' })
        .select(PARENT_FIELDS)
        .single()

      if (insertError) {
        // A concurrent request with the same key won the unique index.
        const { data: raced } = await db
          .from('email_broadcasts')
          .select(PARENT_FIELDS)
          .eq('request_key', requestKey)
          .maybeSingle()
        if (!raced) {
          console.error('Broadcast record creation failed:', insertError.message)
          return NextResponse.json({ error: 'Could not start broadcast' }, { status: 500 })
        }
        parent = raced
      } else {
        parent = created
      }
    }

    // ---- 5. terminal parent: return the stored result, send nothing ---------
    if (['completed', 'partial', 'failed'].includes(parent.status)) {
      const batches = await loadBatches(db, parent.id)
      const agg = aggregate(batches)
      return NextResponse.json({
        success: parent.status === 'completed',
        attempted: parent.attempted,
        succeeded: parent.succeeded,
        failed: parent.failed,
        uncertain: agg.uncertain,
        batches: batches.length,
        status: parent.status,
      })
    }

    // ---- 6-7. lease: claimed atomically BEFORE any planning ----------------
    const worker = crypto.randomUUID()
    const nowIso = new Date().toISOString()
    const { data: leased } = await db
      .from('email_broadcasts')
      .update({
        status: 'sending',
        lease_owner: worker,
        lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
      })
      .eq('id', parent.id)
      .in('status', ['pending', 'sending'])
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
      .select('id')
      .maybeSingle()

    if (!leased) {
      // Someone else holds a live lease. Do not launch a second worker.
      return NextResponse.json({ success: false, still_processing: true, status: 'sending' })
    }
    claimed = { admin: db, broadcastId: parent.id }

    // ---- 8. planning --------------------------------------------------------
    let batches = await loadBatches(db, parent.id)

    if (parent.planned_batches === null) {
      if (batches.length === 0) {
        // Case A: nothing planned yet. This is the ONLY point at which tier
        // membership is read; every later attempt uses the frozen rows.
        const { data: profiles, error: recipientError } = await db
          .from('user_profiles')
          .select('email')
          .eq('subscription_tier', tier)
          .order('email', { ascending: true })

        if (recipientError) {
          console.error('Broadcast recipient lookup failed:', recipientError.message)
          return NextResponse.json({ error: 'Could not resolve recipients' }, { status: 500 })
        }

        const seen = new Set<string>()
        const recipients: string[] = []
        for (const row of profiles ?? []) {
          const email = String(row.email ?? '').trim().toLowerCase()
          if (!email || !email.includes('@')) continue
          if (email === (auth.email ?? '').toLowerCase()) continue
          if (seen.has(email)) continue
          seen.add(email)
          recipients.push(email)
        }

        if (recipients.length === 0) {
          await db
            .from('email_broadcasts')
            .update({
              attempted: 0,
              succeeded: 0,
              failed: 0,
              status: 'completed',
              completed_at: new Date().toISOString(),
              lease_owner: null,
              lease_expires_at: null,
            })
            .eq('id', parent.id)
          claimed = null
          return NextResponse.json({
            success: true, attempted: 0, succeeded: 0, failed: 0, uncertain: 0,
            batches: 0, status: 'completed',
          })
        }

        const preview = message.length > 150 ? `${message.slice(0, 150)}...` : message
        const html = buildNotificationEmail('CRNA Prep Hub Admin', preview)

        const rows: any[] = []
        for (let i = 0; i < recipients.length; i += MAX_BATCH_SIZE) {
          const chunk = recipients.slice(i, i + MAX_BATCH_SIZE)
          const index = rows.length
          rows.push({
            broadcast_id: parent.id,
            batch_index: index,
            // The exact array handed to Resend, frozen here and replayed
            // verbatim on every retry.
            payload: chunk.map((to) => ({
              from: NOTIFICATION_FROM,
              to,
              subject: NOTIFICATION_SUBJECT,
              html,
            })),
            idempotency_key: `message-broadcast-${parent.id}-batch-${index}`,
            recipient_count: chunk.length,
            status: 'pending',
          })
        }

        // One statement: all-or-nothing at the statement level.
        const { error: planError } = await db.from('email_broadcast_batches').insert(rows)
        if (planError) {
          console.error('Broadcast planning failed:', planError.message)
          return NextResponse.json({ error: 'Could not plan broadcast' }, { status: 500 })
        }

        batches = await loadBatches(db, parent.id)
      }

      // Case A and B converge here. Case B adopts pre-existing rows written by
      // a previous attempt that died before the marker was set — membership is
      // NOT re-read.
      const planned = batches.length
      const attempted = batches.reduce((n, b) => n + b.recipient_count, 0)
      const { error: markError } = await db
        .from('email_broadcasts')
        .update({ planned_batches: planned, attempted })
        .eq('id', parent.id)
        .is('planned_batches', null)
      if (markError) {
        console.error('Broadcast plan confirmation failed:', markError.message)
        return NextResponse.json({ error: 'Could not confirm broadcast plan' }, { status: 500 })
      }
      parent = { ...parent, planned_batches: planned, attempted }
    }
    // Case C needs no action: planned_batches is set, the rows are authoritative.

    // ---- 9. reconciliation. Nothing is sent unless the plan is coherent -----
    const attemptedSum = batches.reduce((n, b) => n + b.recipient_count, 0)
    const contiguous = batches.every((b, i) => b.batch_index === i)
    const payloadsOk = batches.every(
      (b) =>
        ['sent', 'failed', 'uncertain'].includes(b.status) ||
        (Array.isArray(b.payload) && (b.payload as unknown[]).length === b.recipient_count)
    )
    const keysOk = batches.every((b) => Boolean(b.idempotency_key))

    if (
      parent.planned_batches === null ||
      batches.length !== parent.planned_batches ||
      !contiguous ||
      !payloadsOk ||
      !keysOk ||
      parent.attempted !== attemptedSum
    ) {
      console.error('Broadcast plan failed reconciliation', {
        broadcast: parent.id,
        planned: parent.planned_batches,
        rows: batches.length,
        contiguous,
        payloadsOk,
        keysOk,
        attempted: parent.attempted,
        attemptedSum,
      })
      await db
        .from('email_broadcasts')
        .update({ lease_owner: null, lease_expires_at: null })
        .eq('id', parent.id)
      claimed = null
      return NextResponse.json(
        { error: 'Broadcast plan failed integrity check; nothing was sent' },
        { status: 409 }
      )
    }

    // ---- 10. batch processing ----------------------------------------------
    for (const batch of batches) {
      if (['sent', 'failed', 'uncertain'].includes(batch.status)) continue

      if (batch.status === 'submitting') {
        const submittedAt = batch.submitted_at ? Date.parse(batch.submitted_at) : 0
        if (!submittedAt || Date.now() - submittedAt >= SAFE_REPLAY_WINDOW_MS) {
          // Outside Resend's retention: the original request may have been
          // accepted, and its idempotency record has expired. Replaying could
          // duplicate delivery, so a human decides.
          await db
            .from('email_broadcast_batches')
            .update({
              status: 'uncertain',
              completed_at: new Date().toISOString(),
              last_error:
                'submission outcome unknown; outside safe idempotency window, not replayed',
            })
            .eq('id', batch.id)
          continue
        }
        // Inside the window: replay the frozen payload under the stored key.
      } else {
        // pending -> submitting, persisted BEFORE the Resend call so a crash
        // here leaves evidence. submitted_at is set once and never reset: the
        // safe-replay window runs from the first submission.
        const { error } = await db
          .from('email_broadcast_batches')
          .update({
            status: 'submitting',
            submitted_at: new Date().toISOString(),
            attempts: batch.attempts + 1,
          })
          .eq('id', batch.id)
        if (error) {
          console.error(`Broadcast batch ${batch.batch_index} could not be marked:`, error.message)
          continue
        }
      }

      let attemptsUsed = batch.attempts
      let lastCode = 'unknown_error'
      let lastMessage = ''
      let sent = false

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attemptsUsed += 1
        const { error } = await resend.batch.send(batch.payload as any, {
          idempotencyKey: batch.idempotency_key,
        })
        if (!error) {
          sent = true
          break
        }
        lastCode = error.name ?? 'unknown_error'
        lastMessage = error.message ?? ''
        if (!RETRYABLE.has(lastCode) || attempt === MAX_ATTEMPTS) break
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
      }

      if (sent) {
        await db
          .from('email_broadcast_batches')
          .update({
            status: 'sent',
            completed_at: new Date().toISOString(),
            last_error: null,
            attempts: attemptsUsed,
          })
          .eq('id', batch.id)
      } else if (RETRYABLE.has(lastCode)) {
        // Transient and still unresolved. Left as `submitting` so a later
        // request can replay it inside the window rather than writing it off.
        await db
          .from('email_broadcast_batches')
          .update({ last_error: `${lastCode}: ${lastMessage}`, attempts: attemptsUsed })
          .eq('id', batch.id)
      } else {
        await db
          .from('email_broadcast_batches')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            last_error: `${lastCode}: ${lastMessage}`,
            attempts: attemptsUsed,
          })
          .eq('id', batch.id)
      }
    }

    // ---- 11. aggregates, derived from the rows ------------------------------
    const finalBatches = await loadBatches(db, parent.id)
    const agg = aggregate(finalBatches)

    await db
      .from('email_broadcasts')
      .update({
        succeeded: agg.succeeded,
        failed: agg.failed,
        status: agg.status,
        completed_at: agg.status === 'sending' ? null : new Date().toISOString(),
        lease_owner: null,
        lease_expires_at: null,
      })
      .eq('id', parent.id)
    claimed = null

    return NextResponse.json({
      success: agg.status === 'completed',
      attempted: parent.attempted,
      succeeded: agg.succeeded,
      failed: agg.failed,
      uncertain: agg.uncertain,
      batches: finalBatches.length,
      status: agg.status,
      ...(agg.outstanding > 0 ? { still_processing: true } : {}),
    })
  } catch (error) {
    console.error('Broadcast error:', error)
    if (claimed) {
      // Release the lease so a retry can recover immediately rather than
      // waiting it out.
      await claimed.admin
        .from('email_broadcasts')
        .update({ lease_owner: null, lease_expires_at: null })
        .eq('id', claimed.broadcastId)
    }
    return NextResponse.json({ error: 'Broadcast failed' }, { status: 500 })
  }
}

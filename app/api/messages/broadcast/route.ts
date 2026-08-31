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
 * Replaces a browser loop that fired one unawaited /api/messages/notify
 * request per recipient — 114 concurrent requests, each making its own Resend
 * call, whose { data, error } result was never inspected. Around 19 emails
 * were accepted and the rest vanished silently.
 *
 * Everything now happens here: recipients are resolved server-side, sent in
 * batches of at most 100 through the Resend Batch API, awaited sequentially,
 * and every result is checked. The browser learns only aggregate counts.
 */

// Two sequential batch calls plus retries. Well inside Vercel's ceiling, and
// far short of what 114 individual sends would have needed.
export const maxDuration = 60

const resend = new Resend(process.env.RESEND_API_KEY)

/** Resend's documented maximum emails per batch call. */
const MAX_BATCH_SIZE = 100
const MAX_ATTEMPTS = 4
const BASE_BACKOFF_MS = 1000

const ALLOWED_TIERS = ['free', 'premium', 'ultimate'] as const
type Tier = (typeof ALLOWED_TIERS)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Transient conditions worth retrying. Everything else — quota exhaustion, a
 * bad from address, validation or permission failures — is reported straight
 * back, because retrying cannot fix it and would only burn the window.
 */
const RETRYABLE = new Set(['rate_limit_exceeded', 'internal_server_error', 'application_error'])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type BatchError = { batch: number; code: string }

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

export async function POST(request: NextRequest) {
  try {
    // 1. Authentication, then admin authorization. The service-role client is
    //    not constructed until both have passed.
    const auth = await authenticateRequest()
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (!isAdminEmail(auth.email)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

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

    if (!ALLOWED_TIERS.includes(tier as Tier)) {
      return NextResponse.json({ error: 'Invalid tier' }, { status: 400 })
    }
    if (!UUID_RE.test(requestKey)) {
      return NextResponse.json({ error: 'Invalid request key' }, { status: 400 })
    }
    if (!subject || !message.trim()) {
      return NextResponse.json({ error: 'Subject and message are required' }, { status: 400 })
    }

    const admin = serviceClient()
    if (!admin) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    // 2. Duplicate protection. A replayed requestKey conflicts on the unique
    //    index; we read the existing row and report it rather than sending a
    //    second time.
    const { data: existing } = await admin
      .from('email_broadcasts')
      .select('id, attempted, succeeded, failed, status')
      .eq('request_key', requestKey)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({
        success: existing.status === 'completed',
        duplicate: true,
        attempted: existing.attempted,
        succeeded: existing.succeeded,
        failed: existing.failed,
        status: existing.status,
      })
    }

    // 3. Recipients, resolved server-side. The browser never sends or receives
    //    an address.
    const { data: profiles, error: recipientError } = await admin
      .from('user_profiles')
      .select('email')
      .eq('subscription_tier', tier)

    if (recipientError) {
      console.error('Broadcast recipient lookup failed:', recipientError.message)
      return NextResponse.json({ error: 'Could not resolve recipients' }, { status: 500 })
    }

    const seen = new Set<string>()
    const recipients: string[] = []
    for (const row of profiles ?? []) {
      const email = String(row.email ?? '').trim().toLowerCase()
      if (!email || !email.includes('@')) continue
      // The admin receives the in-app message; they do not need the customer
      // email announcing their own broadcast.
      if (email === (auth.email ?? '').toLowerCase()) continue
      if (seen.has(email)) continue
      seen.add(email)
      recipients.push(email)
    }

    if (recipients.length === 0) {
      return NextResponse.json({ success: true, attempted: 0, succeeded: 0, failed: 0, batches: 0 })
    }

    // 4. Durable record, created before anything is sent, so its id can key
    //    the Resend batches and the counters survive a crash mid-send.
    const { data: broadcast, error: insertError } = await admin
      .from('email_broadcasts')
      .insert({
        request_key: requestKey,
        tier,
        subject,
        created_by: auth.userId,
        attempted: recipients.length,
        status: 'sending',
      })
      .select('id')
      .single()

    if (insertError || !broadcast) {
      // A concurrent request with the same key may have won the race.
      const { data: raced } = await admin
        .from('email_broadcasts')
        .select('id, attempted, succeeded, failed, status')
        .eq('request_key', requestKey)
        .maybeSingle()
      if (raced) {
        return NextResponse.json({
          success: raced.status === 'completed',
          duplicate: true,
          attempted: raced.attempted,
          succeeded: raced.succeeded,
          failed: raced.failed,
          status: raced.status,
        })
      }
      console.error('Broadcast record creation failed:', insertError?.message)
      return NextResponse.json({ error: 'Could not start broadcast' }, { status: 500 })
    }

    // 5. Send. Sequential batches of at most 100, every result inspected.
    const preview = message.length > 150 ? `${message.slice(0, 150)}...` : message
    const html = buildNotificationEmail('CRNA Prep Hub Admin', preview)

    const batches: string[][] = []
    for (let i = 0; i < recipients.length; i += MAX_BATCH_SIZE) {
      batches.push(recipients.slice(i, i + MAX_BATCH_SIZE))
    }

    let succeeded = 0
    let failed = 0
    const errors: BatchError[] = []

    for (let index = 0; index < batches.length; index++) {
      const chunk = batches[index]
      // Derived from the durable broadcast id, so retrying this batch — here
      // or in a later request — cannot deliver to the same people twice.
      const idempotencyKey = `message-broadcast-${broadcast.id}-batch-${index}`
      let lastCode = 'unknown_error'
      let sent = false

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { error } = await resend.batch.send(
          chunk.map((to) => ({
            from: NOTIFICATION_FROM,
            to,
            subject: NOTIFICATION_SUBJECT,
            html,
          })),
          { idempotencyKey }
        )

        if (!error) {
          sent = true
          break
        }

        lastCode = error.name ?? 'unknown_error'
        if (!RETRYABLE.has(lastCode) || attempt === MAX_ATTEMPTS) {
          console.error(`Broadcast batch ${index} failed:`, lastCode, error.message)
          break
        }
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
      }

      if (sent) succeeded += chunk.length
      else {
        failed += chunk.length
        errors.push({ batch: index + 1, code: lastCode })
      }
    }

    const status = failed === 0 ? 'completed' : succeeded === 0 ? 'failed' : 'partial'
    const { error: updateError } = await admin
      .from('email_broadcasts')
      .update({ succeeded, failed, status, completed_at: new Date().toISOString() })
      .eq('id', broadcast.id)
    if (updateError) console.error('Broadcast record update failed:', updateError.message)

    // 6. Aggregate only. No addresses, no user ids, no Resend detail beyond an
    //    error code.
    return NextResponse.json({
      success: failed === 0,
      attempted: recipients.length,
      succeeded,
      failed,
      batches: batches.length,
      ...(errors.length ? { errors } : {}),
    })
  } catch (error) {
    console.error('Broadcast error:', error)
    return NextResponse.json({ error: 'Broadcast failed' }, { status: 500 })
  }
}

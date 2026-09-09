import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { randomUUID } from 'crypto'
import { isAdminEmail } from '@/lib/apiAuth'
import {
  NOTIFICATION_FROM,
  NOTIFICATION_SUBJECT,
  buildNotificationEmail,
} from '@/lib/messageNotify'
import { claimJobs } from '@/lib/messaging/notificationClaim'
import {
  runWorker,
  senderNameFor,
  previewFor,
  type JobRow,
  type SendOutcome,
  type WorkerDeps,
} from '@/lib/messaging/notificationWorker'

/**
 * Durable notification worker.
 *
 * NOT SCHEDULED. There is no vercel.json and no cron entry in this phase, so
 * nothing invokes this route -- and it additionally refuses to run at all
 * unless CRON_SECRET is configured, which it is not. Both must change before a
 * single production job is touched.
 *
 * Decision logic lives in lib/messaging/notificationWorker.ts, isolated from
 * Supabase, Resend and Next so every branch is testable without a network call
 * or a real row. This file is the shell: authenticate, wire the effects, run.
 */

export const maxDuration = 60

const resend = new Resend(process.env.RESEND_API_KEY)

/**
 * Cron only.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set.
 * A browser -- anonymous, member, or the admin's own session -- never carries
 * it, so no browser can reach the queue through this route regardless of who
 * is signed in. There is deliberately no session path at all.
 *
 * Fails CLOSED when the secret is absent: an unconfigured deployment refuses
 * rather than running unauthenticated.
 */
function authorize(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('Notification worker: CRON_SECRET is not configured; refusing to run')
    return NextResponse.json({ error: 'Worker not configured' }, { status: 503 })
  }
  const header = request.headers.get('authorization') ?? ''
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

function serviceClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return null
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Everything the email needs, from the immutable message and the profiles. */
async function resolvePayload(db: SupabaseClient, job: JobRow) {
  const { data: message } = await db
    .from('thread_messages')
    .select('message_text, sender_id')
    .eq('id', job.message_id)
    .maybeSingle()
  if (!message) return null

  const { data: recipient } = await db
    .from('user_profiles')
    .select('email')
    .eq('id', job.recipient_user_id)
    .maybeSingle()
  if (!recipient?.email) return null

  let senderEmail: string | null = null
  if (message.sender_id) {
    const { data: sender } = await db
      .from('user_profiles')
      .select('email')
      .eq('id', message.sender_id)
      .maybeSingle()
    senderEmail = sender?.email ?? null
  }

  return {
    recipientEmail: recipient.email as string,
    senderName: senderNameFor(senderEmail, isAdminEmail(senderEmail)),
    preview: previewFor(message.message_text as string | null),
  }
}

/**
 * One handler, exposed as both methods.
 *
 * Vercel Cron invokes a configured path with GET; POST is kept for a manual
 * operator run. They are the SAME function object, not two functions that
 * happen to agree -- there is no second copy of the worker body to drift.
 */
async function handleWorkerRequest(request: NextRequest) {
  const refused = authorize(request)
  if (refused) return refused

  const db = serviceClient()
  if (!db) {
    console.error('Notification worker: SUPABASE_SERVICE_ROLE_KEY is not configured')
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
  }

  const workerId = `worker-${randomUUID()}`

  const deps: WorkerDeps = {
    now: () => Date.now(),
    claim: (id, now) => claimJobs(db, id, now),
    resolvePayload: (job) => resolvePayload(db, job),
    send: async ({ to, senderName, preview, idempotencyKey }): Promise<SendOutcome> => {
      // The SAME builder the browser notify route uses, so the two renderings
      // cannot drift apart.
      const { error } = await resend.emails.send(
        {
          from: NOTIFICATION_FROM,
          to,
          subject: NOTIFICATION_SUBJECT,
          html: buildNotificationEmail(senderName, preview),
        },
        { idempotencyKey },
      )
      if (!error) return { ok: true }
      return { ok: false, code: error.name ?? 'unknown_error', message: error.message ?? '' }
    },
    // Only the seven columns service_role holds UPDATE on. message_id and
    // recipient_user_id are never in a patch, and the grant would refuse them.
    update: async (messageId, patch) => {
      await db.from('email_notification_jobs').update(patch).eq('message_id', messageId)
    },
  }

  try {
    const results = await runWorker(workerId, deps)
    // Counts only -- never a recipient, a message, or a queue row.
    const tally = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1
      return acc
    }, {})
    return NextResponse.json({ processed: results.length, ...tally })
  } catch (error) {
    // The worker holds a rendered preview in memory; log only the shape of
    // the failure, never the object that might close over it.
    console.error('Notification worker error:', (error as any)?.code, (error as any)?.message)
    return NextResponse.json({ error: 'Worker failed' }, { status: 500 })
  }
}

export const GET = handleWorkerRequest
export const POST = handleWorkerRequest

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { authenticateRequest, isAdminEmail, readAccessToken } from '@/lib/apiAuth'

const resend = new Resend(process.env.RESEND_API_KEY)

/**
 * Authorized message-notification email.
 *
 * Previously this ran with no authentication at all: any caller could POST an
 * arbitrary recipientId, senderName and messagePreview and make CRNA Prep Hub
 * email that person, with the "From" line saying whatever they wanted --
 * including "CRNA Prep Hub Admin". That is a spam and impersonation vector on
 * the sending domain, so identity and content are now derived server-side.
 *
 * What the caller may still supply: recipientId, and nothing else. It is
 * checked against the database before any email is looked up or sent.
 */

/** Minimal HTML escaping for values interpolated into the email body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The notification email from address, shared by the single and batch paths. */
export const NOTIFICATION_FROM = 'CRNA Prep Hub <notifications@crnaprephub.com>'
export const NOTIFICATION_SUBJECT = 'New Message from CRNA Prep Hub'

/**
 * One template for both the single-recipient notification and tier
 * broadcasts, so the two cannot drift. Both inputs are escaped here rather
 * than at the call sites.
 */
export function buildNotificationEmail(senderName: string, preview: string): string {
  const safeSenderName = escapeHtml(senderName)
  const safePreview = escapeHtml(preview)
  return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9fafb; padding: 20px;">
          <!-- Header -->
          <div style="background: linear-gradient(to right, #7c3aed, #ec4899); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">CRNA Prep Hub</h1>
            <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Your Path to CRNA School Success</p>
          </div>
          
          <!-- Message Content -->
          <div style="background: white; padding: 30px; border-radius: 0 0 12px 12px;">
            <h2 style="color: #7c3aed; margin-top: 0;">You have a new message!</h2>
            <p style="color: #6b7280;"><strong>From:</strong> ${safeSenderName}</p>
            
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #7c3aed;">
              <p style="margin: 0; color: #374151; line-height: 1.6;">${safePreview}</p>
            </div>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="https://crnaprephub.com/dashboard" 
                 style="background: linear-gradient(to right, #7c3aed, #ec4899); color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold; font-size: 16px;">
                View Full Message →
              </a>
            </div>
            
            <!-- Features Section -->
            <div style="border-top: 2px solid #e5e7eb; margin-top: 40px; padding-top: 30px;">
              <h3 style="color: #1f2937; font-size: 18px; margin-bottom: 20px;">What's on CRNA Prep Hub:</h3>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">🏫</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">149+ CRNA Programs</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Searchable database with filters for GPA, tuition, location & more</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">🎤</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">AI Mock Interviews</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Practice with instant feedback and realistic CRNA interview questions</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">📄</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">Resume Builder</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Create professional CRNA resumes with AI-enhanced bullet points</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">📊</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">GPA Calculator</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Calculate cumulative, science, and nursing GPAs with semester tracking</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">✍️</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">Personal Statement Analyzer</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Get AI feedback and suggestions to improve your application essay</p>
                </div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <div style="display: inline-block; width: 40px; height: 40px; background: linear-gradient(to right, #7c3aed, #ec4899); border-radius: 8px; text-align: center; line-height: 40px; font-size: 20px; margin-right: 12px; vertical-align: middle;">📚</div>
                <div style="display: inline-block; vertical-align: middle;">
                  <strong style="color: #1f2937;">School-Specific Prep</strong>
                  <p style="margin: 2px 0 0 0; color: #6b7280; font-size: 14px;">Learn each program's unique interview style and format</p>
                </div>
              </div>
            </div>
            
            <!-- Footer -->
            <div style="text-align: center; margin-top: 40px; padding-top: 20px; border-top: 2px solid #e5e7eb;">
              <p style="color: #9ca3af; font-size: 14px; margin: 5px 0;">
                <a href="https://crnaprephub.com" style="color: #7c3aed; text-decoration: none;">crnaprephub.com</a>
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin: 5px 0;">
                Your complete resource for CRNA school preparation
              </p>
            </div>
          </div>
        </div>
      `
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function handleMessageNotification(request: NextRequest) {
  try {
    // 1. Authentication. No session means no lookup, no Resend call, no
    //    privileged client.
    const auth = await authenticateRequest()
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = await readAccessToken()
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: any = {}
    try {
      body = await request.json()
    } catch {
      body = {}
    }

    const recipientId = typeof body?.recipientId === 'string' ? body.recipientId : ''
    if (!UUID_RE.test(recipientId)) {
      return NextResponse.json({ error: 'Invalid recipient' }, { status: 400 })
    }

    // senderName and messagePreview may still arrive from older clients. They
    // are read only as an admin's own outgoing copy (see below) and never
    // determine identity.
    const claimedPreview = typeof body?.messagePreview === 'string' ? body.messagePreview : ''

    // Optional: the id of the message that triggered this notification. When
    // supplied, the preview comes from that exact row rather than "the
    // caller's most recent message in a shared thread" -- two replies landing
    // together would otherwise email the wrong text.
    const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
    if (messageId && !UUID_RE.test(messageId)) {
      return NextResponse.json({ error: 'Invalid message id' }, { status: 400 })
    }

    // Optional: the thread create_thread_with_message just created. Compose has
    // this and cannot have the message id -- the RPC returns only the thread.
    // It is used ONLY to look the message up server-side; a client-supplied
    // message id is never trusted for Compose.
    const threadId = typeof body?.threadId === 'string' ? body.threadId : ''
    if (threadId && !UUID_RE.test(threadId)) {
      return NextResponse.json({ error: 'Invalid thread id' }, { status: 400 })
    }

    // 2. Sender identity from the verified session only.
    const isAdmin = isAdminEmail(auth.email)
    const senderName = isAdmin ? 'CRNA Prep Hub Admin' : (auth.email || 'A CRNA Prep Hub member')

    // 3. Authorization, against the database.
    //    Caller-scoped client, so RLS still applies while membership is read.
    const userClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    )

    const { data: myThreads } = await userClient
      .from('thread_participants')
      .select('thread_id')
      .eq('user_id', auth.userId)

    const myThreadIds = Array.from(new Set((myThreads ?? []).map((t) => t.thread_id)))

    let sharedThreadIds: string[] = []
    if (myThreadIds.length > 0) {
      const { data: shared } = await userClient
        .from('thread_participants')
        .select('thread_id')
        .eq('user_id', recipientId)
        .in('thread_id', myThreadIds)
      sharedThreadIds = Array.from(new Set((shared ?? []).map((t) => t.thread_id)))
    }

    // An ordinary member may only notify someone they already share a thread
    // with. An admin may notify any member: admin broadcasts create threads
    // through an RPC whose membership this route cannot always observe, and
    // messaging any member is the intended admin capability. Admin status is
    // established from the verified session, never from the request.
    if (sharedThreadIds.length === 0 && !isAdmin) {
      return NextResponse.json({ error: 'Not authorized to notify this user' }, { status: 403 })
    }

    // 4. Only now is the service role constructed. No anon-key fallback: a
    //    missing key fails loudly rather than silently sending nothing.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) {
      console.error('Message notification: SUPABASE_SERVICE_ROLE_KEY is not configured')
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // 5. Preview text from the stored message wherever one exists, so the
    //    browser cannot fabricate the body of an email we send.
    // resolvedMessageId is the provider idempotency key's only source. It is
    // assigned in exactly two places below, each identifying one exact row. It
    // is never derived from "the newest message": that can name a different
    // message than the one this notification is for, and a key built on the
    // wrong message makes the provider suppress a real email.
    let resolvedMessageId: string | null = null
    let preview = ''
    if (messageId) {
      // Named message: it must have been written by the caller and must sit in
      // a thread the caller shares with this recipient. Both are checked
      // against the database, so an id belonging to someone else's
      // conversation cannot be used to email its contents.
      const { data: named } = await adminClient
        .from('thread_messages')
        .select('message_text, sender_id, thread_id')
        .eq('id', messageId)
        .maybeSingle()

      if (
        !named ||
        named.sender_id !== auth.userId ||
        !sharedThreadIds.includes(named.thread_id)
      ) {
        return NextResponse.json({ error: 'Message not found for this conversation' }, { status: 403 })
      }
      resolvedMessageId = messageId
      preview = String(named.message_text ?? '')
    } else if (threadId) {
      // Compose. create_thread_with_message inserts exactly ONE message into a
      // brand-new thread, so "the caller's message in this thread" names that
      // row exactly -- by construction, not by ordering.
      //
      // Anything other than one row means a reply landed between the RPC and
      // this request. Rather than choose, the key is dropped: no key risks a
      // duplicate, a wrong key suppresses a real email, and the first is much
      // the smaller harm.
      if (!sharedThreadIds.includes(threadId)) {
        return NextResponse.json(
          { error: 'Message not found for this conversation' },
          { status: 403 },
        )
      }
      const { data: authored } = await adminClient
        .from('thread_messages')
        .select('id, message_text')
        .eq('thread_id', threadId)
        .eq('sender_id', auth.userId)
        .limit(2)

      if ((authored ?? []).length === 1) {
        resolvedMessageId = authored![0].id
        preview = String(authored![0].message_text ?? '')
      } else {
        // Thread id and a count only -- no message text, no address, no token.
        console.warn(
          'Notification idempotency: thread',
          threadId,
          'has',
          (authored ?? []).length,
          'caller-authored messages; sending without an idempotency key',
        )
      }
    } else if (sharedThreadIds.length > 0) {
      // PREVIEW ONLY. It deliberately does not select `id`: this query is
      // ordered, so the row it returns is not provably the message this
      // notification is for, and it must never reach resolvedMessageId.
      const { data: lastMessage } = await adminClient
        .from('thread_messages')
        .select('message_text')
        .eq('sender_id', auth.userId)
        .in('thread_id', sharedThreadIds)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (lastMessage?.message_text) preview = String(lastMessage.message_text)
    }

    // Admin broadcasts are dispatched by an RPC that may not leave an
    // observable shared thread here. Falling back to the admin's own supplied
    // text is not an escalation -- an admin can already send any message --
    // and it is escaped like everything else. Members never get this fallback.
    if (!preview && isAdmin && claimedPreview) preview = claimedPreview
    if (!preview) preview = 'You have a new message on CRNA Prep Hub.'
    if (preview.length > 150) preview = `${preview.slice(0, 150)}...`

    const { data: recipient } = await adminClient
      .from('user_profiles')
      .select('email')
      .eq('id', recipientId)
      .single()

    if (!recipient?.email) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 })
    }

    // The same key the durable worker will use, so the two systems cannot both
    // deliver the same message. Omitted entirely when the exact message could
    // not be proven -- today's behaviour, unchanged.
    const idempotencyKey = resolvedMessageId ? `message-notification-${resolvedMessageId}` : null

    const { error: sendError } = await resend.emails.send(
      {
        from: NOTIFICATION_FROM,
        to: recipient.email,
        subject: NOTIFICATION_SUBJECT,
        html: buildNotificationEmail(senderName, preview),
      },
      idempotencyKey ? { idempotencyKey } : undefined,
    )

    // The Resend SDK resolves with { data, error } rather than throwing on an
    // API rejection, so an unchecked await reported rate limits and quota
    // errors as success. That is how a 114-recipient broadcast delivered ~19
    // emails without surfacing anything.
    if (sendError) {
      console.error('Resend rejected notification:', sendError.name, sendError.message)
      return NextResponse.json({ error: 'Notification failed' }, { status: 502 })
    }


    // Deliberately minimal: the Resend response echoes recipient details, so
    // it is not passed back to the browser.
    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Message notification error:', error)
    return NextResponse.json({ error: 'Notification failed' }, { status: 500 })
  }
}

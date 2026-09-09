import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { authenticateRequest, readAccessToken } from '@/lib/apiAuth'
import { pageAll, fetchByIdChunks, chunkIds, ID_CHUNK } from '@/lib/messaging/pagination'

/**
 * Thread metadata for the caller's inbox.
 *
 * Two problems this solves.
 *
 * 1. Display names. user_profiles is no longer readable across users, so the
 *    counterpart's address has to be resolved here. The set of users whose
 *    address may be returned is derived from the caller's own thread
 *    membership — supplying an arbitrary UUID reveals nothing.
 *
 * 2. Truncation and fan-out. Every list query below is paginated: PostgREST
 *    caps an unbounded request at 1000 rows, and with 522 threads the
 *    participant lookup needed 1044 — so roughly two dozen conversations
 *    silently rendered as "Unknown". The client also issued one query per
 *    thread to find each counterpart; that fan-out is replaced by the
 *    per-thread metadata returned here.
 *
 * 3. Query-string length. Paging was not enough: `.range()` re-sends the
 *    whole id list on every page, so once the caller held more than ~396
 *    threads every `.in()` here was rejected at the HTTP layer and this route
 *    returned 500 for its largest inboxes. The id lists are chunked now. See
 *    lib/messaging/pagination.ts.
 *
 * Broadcast grouping is computed here too, and is PRESENTATION ONLY. It never
 * informs authorization, delivery, ownership or email idempotency.
 */

export const maxDuration = 60

/** A fan-out must be at least this many threads. Two same-subject messages
 *  sent by hand are never treated as a broadcast. */
const MIN_GROUP_SIZE = 3

/** Threads of one broadcast are written together; this tolerates a slow
 *  insert straddling a second (or minute) boundary without merging separate
 *  sends of the same content days apart. */
const GROUP_WINDOW_MS = 10 * 60 * 1000

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest()
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const token = await readAccessToken()
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Caller-scoped: RLS still applies while membership is established.
    const userClient: SupabaseClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    )

    // 1. The caller's threads.
    const myRows = await pageAll<{ thread_id: string }>((from, to) =>
      userClient
        .from('thread_participants')
        .select('thread_id')
        .eq('user_id', auth.userId)
        .is('deleted_at', null)
        .range(from, to)
    )
    const threadIds = Array.from(new Set(myRows.map((r) => r.thread_id)))
    if (threadIds.length === 0) {
      return NextResponse.json({ emails: {}, threads: [], groups: [] })
    }

    // 2. Everyone in those threads, and everyone who has posted in them. This
    //    set — never the request body — bounds what may be resolved.
    const participants = await fetchByIdChunks<{ thread_id: string; user_id: string }>(
      threadIds,
      (chunk, from, to) =>
        userClient
          .from('thread_participants')
          .select('thread_id, user_id')
          .in('thread_id', chunk)
          .range(from, to)
    )
    const messages = await fetchByIdChunks<{
      thread_id: string
      sender_id: string
      message_text: string
      created_at: string
      id: string
    }>(threadIds, (chunk, from, to) =>
      userClient
        .from('thread_messages')
        .select('id, thread_id, sender_id, message_text, created_at')
        .in('thread_id', chunk)
        .order('created_at', { ascending: true })
        .range(from, to)
    )

    const authorized = new Set<string>()
    for (const p of participants) if (p.user_id) authorized.add(p.user_id)
    for (const m of messages) if (m.sender_id) authorized.add(m.sender_id)

    // 3. Only now the service role, and only for an id set the database has
    //    already confirmed shares a conversation with the caller.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) {
      console.error('Participant lookup: service role key missing')
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }
    const adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const ids = Array.from(authorized)
    const emails: Record<string, { email: string }> = {}
    // Chunked by id count, not by page size: 900 ids overruns the query string.
    for (const chunk of chunkIds(ids, ID_CHUNK)) {
      const { data, error } = await adminClient
        .from('user_profiles')
        .select('id, email')
        .in('id', chunk)
      if (error) throw new Error(error.message)
      for (const p of data ?? []) if (p.id && p.email) emails[p.id] = { email: p.email }
    }

    // 4. Threads and read state, both paginated.
    const threadRows = await fetchByIdChunks<{
      id: string
      subject: string
      created_by: string
      created_at: string
      updated_at: string
    }>(threadIds, (chunk, from, to) =>
      adminClient
        .from('message_threads')
        .select('id, subject, created_by, created_at, updated_at')
        .in('id', chunk)
        .range(from, to)
    )
    const readRows = await fetchByIdChunks<{
      message_id: string
      user_id: string
      read_at: string | null
    }>(
      messages.map((m) => m.id),
      (chunk, from, to) =>
        adminClient
          .from('message_read_status')
          .select('message_id, user_id, read_at')
          .in('message_id', chunk)
          .range(from, to)
    )

    const byThread = new Map<string, typeof messages>()
    for (const m of messages) {
      const list = byThread.get(m.thread_id) ?? []
      list.push(m)
      byThread.set(m.thread_id, list)
    }
    const readByMessage = new Map<string, { user_id: string; read_at: string | null }[]>()
    for (const r of readRows) {
      const list = readByMessage.get(r.message_id) ?? []
      list.push(r)
      readByMessage.set(r.message_id, list)
    }
    const counterparts = new Map<string, string[]>()
    for (const p of participants) {
      if (p.user_id === auth.userId) continue
      const list = counterparts.get(p.thread_id) ?? []
      list.push(p.user_id)
      counterparts.set(p.thread_id, list)
    }

    type ThreadMeta = {
      thread_id: string
      counterpart_id: string | null
      message_count: number
      has_reply: boolean
      unread_count: number
      recipient_has_read: boolean
      last_message: string
      last_message_at: string
      group_id: string | null
    }

    const metas: ThreadMeta[] = []
    // Candidates for grouping, keyed by creator + subject + opening message.
    const candidates = new Map<string, { threadId: string; at: number }[]>()

    for (const t of threadRows) {
      const msgs = byThread.get(t.id) ?? []
      const others = counterparts.get(t.id) ?? []
      const hasReply = msgs.some((m) => m.sender_id !== auth.userId)

      let unread = 0
      for (const m of msgs) {
        if (m.sender_id === auth.userId) continue
        const statuses = readByMessage.get(m.id) ?? []
        const mine = statuses.find((s) => s.user_id === auth.userId)
        if (!mine?.read_at) unread++
      }

      const last = msgs[msgs.length - 1]
      let recipientHasRead = true
      if (last && last.sender_id === auth.userId) {
        const statuses = (readByMessage.get(last.id) ?? []).filter((s) => s.user_id !== auth.userId)
        recipientHasRead = statuses.some((s) => Boolean(s.read_at))
      }

      metas.push({
        thread_id: t.id,
        counterpart_id: others[0] ?? null,
        message_count: msgs.length,
        has_reply: hasReply,
        unread_count: unread,
        recipient_has_read: recipientHasRead,
        last_message: last?.message_text ?? '',
        last_message_at: last?.created_at ?? t.created_at,
        group_id: null,
      })

      // Grouping criteria, all required:
      //  - the caller opened it and is still the only voice in it
      //  - exactly one counterpart, i.e. a private one-to-one thread
      //  - identical creator, subject and opening message text
      // Two hand-written messages sharing a subject differ in body and in
      // time, so they cannot collide.
      if (!hasReply && others.length === 1 && msgs.length > 0 && t.created_by === auth.userId) {
        const first = msgs[0]
        if (first.sender_id === auth.userId) {
          const key = createHash('sha256')
            .update(`${t.created_by}|${t.subject}|${first.message_text}`)
            .digest('hex')
            .slice(0, 24)
          const list = candidates.get(key) ?? []
          list.push({ threadId: t.id, at: Date.parse(first.created_at) })
          candidates.set(key, list)
        }
      }
    }

    // 5. Cluster candidates in time, so one send groups and two sends of the
    //    same content months apart do not.
    const metaById = new Map(metas.map((m) => [m.thread_id, m]))
    const subjectByThread = new Map(threadRows.map((t) => [t.id, t.subject]))
    const groups: {
      group_id: string
      subject: string
      recipients: number
      replies: number
      last_message_at: string
    }[] = []

    for (const [key, entries] of candidates) {
      entries.sort((a, b) => a.at - b.at)
      let cluster: typeof entries = []
      const flush = () => {
        if (cluster.length >= MIN_GROUP_SIZE) {
          const groupId = `group-${key}-${cluster[0].at}`
          let latest = ''
          for (const c of cluster) {
            const meta = metaById.get(c.threadId)!
            meta.group_id = groupId
            if (meta.last_message_at > latest) latest = meta.last_message_at
          }
          // Threads with the same content that have since been replied to are
          // reported alongside the group but are NOT part of its count — they
          // render as ordinary conversations.
          const replies = metas.filter(
            (m) =>
              !m.group_id &&
              m.has_reply &&
              subjectByThread.get(m.thread_id) === subjectByThread.get(cluster[0].threadId)
          ).length
          groups.push({
            group_id: groupId,
            subject: String(subjectByThread.get(cluster[0].threadId) ?? ''),
            recipients: cluster.length,
            replies,
            last_message_at: latest,
          })
        }
        cluster = []
      }
      for (const e of entries) {
        if (cluster.length === 0 || e.at - cluster[cluster.length - 1].at <= GROUP_WINDOW_MS) {
          cluster.push(e)
        } else {
          flush()
          cluster = [e]
        }
      }
      flush()
    }

    // Emails only — no tiers, no ids beyond those the caller already shares a
    // conversation with, no message bodies other than the caller's own view.
    return NextResponse.json({ emails, threads: metas, groups })
  } catch (error) {
    // This route reads message_text; never log a whole caught object, whose
    // Postgres `details` could carry a row with it.
    console.error('Participant route error:', (error as any)?.code, (error as any)?.message)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
}

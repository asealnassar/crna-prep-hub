import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { authenticateRequest, readAccessToken } from '@/lib/apiAuth'

/**
 * Display labels for the people the caller actually messages with.
 *
 * Background: user_profiles used to carry a permissive "Anyone can read
 * profiles" policy, so the browser resolved a counterpart's email by querying
 * the table directly. Removing that policy closed an anonymous dump of every
 * profile, and correctly stopped users reading each other's rows — which broke
 * the conversation and sender labels in MessagesModal.
 *
 * This route restores those labels without reopening the table and without
 * becoming a lookup service. It never accepts an identity from the caller: the
 * set of readable users is derived from the caller's own thread membership, so
 * supplying an arbitrary UUID cannot reveal anything. Only `email` is exposed,
 * and only for people already in a conversation with the caller.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequest()
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = await readAccessToken()
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Caller-scoped client: RLS still applies, so membership is established
    // with the caller's own privileges rather than an elevated key.
    const userClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }
    )

    // 1. Threads the caller belongs to.
    const { data: myThreads, error: threadsError } = await userClient
      .from('thread_participants')
      .select('thread_id')
      .eq('user_id', auth.userId)

    if (threadsError) {
      console.error('Participant lookup failed:', threadsError.message)
      return NextResponse.json({}, { status: 200 })
    }

    const threadIds = Array.from(new Set((myThreads ?? []).map((t) => t.thread_id)))
    if (threadIds.length === 0) return NextResponse.json({})

    // 2. Everyone who shares one of those threads, plus anyone who has posted
    //    in them. This set — never the request body — defines what may be read.
    const [{ data: participants }, { data: senders }] = await Promise.all([
      userClient.from('thread_participants').select('user_id').in('thread_id', threadIds),
      userClient.from('thread_messages').select('sender_id').in('thread_id', threadIds),
    ])

    const authorized = new Set<string>()
    for (const row of participants ?? []) if (row.user_id) authorized.add(row.user_id)
    for (const row of senders ?? []) if (row.sender_id) authorized.add(row.sender_id)
    if (authorized.size === 0) return NextResponse.json({})

    // 3. An optional id list only ever narrows the result. Anything the caller
    //    asks for that is not already authorized is discarded, so a client
    //    cannot widen its own access by sending more ids.
    let requested: string[] | null = null
    try {
      const body = await request.json()
      if (Array.isArray(body?.ids)) requested = body.ids.filter((v: unknown) => typeof v === 'string')
    } catch {
      // No body is normal — the caller wants every authorized label.
    }
    const ids = requested ? requested.filter((id) => authorized.has(id)) : Array.from(authorized)
    if (ids.length === 0) return NextResponse.json({})

    // 4. Only now is the service role used, and only for an id set the database
    //    already confirmed the caller shares a conversation with.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceKey) {
      console.error('Participant lookup: service role key missing')
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 })
    }

    const adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: profiles, error: profilesError } = await adminClient
      .from('user_profiles')
      .select('id, email')
      .in('id', ids)

    if (profilesError) {
      console.error('Participant profile fetch failed:', profilesError.message)
      return NextResponse.json({}, { status: 200 })
    }

    // 5. Email only. No tier, no stripe_customer_id, no interview_count, no
    //    created_at — the display label and nothing else.
    const result: Record<string, { email: string }> = {}
    for (const profile of profiles ?? []) {
      if (profile.id && profile.email) result[profile.id] = { email: profile.email }
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Participant route error:', error)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
}

import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

  const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })

  // Get ALL users with pagination
  let allUsers: any[] = []
  let page = 1
  const perPage = 1000

  while (true) {
    const { data: { users }, error } = await adminClient.auth.admin.listUsers({
      page,
      perPage
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!users || users.length === 0) break
    
    allUsers = [...allUsers, ...users]
    
    if (users.length < perPage) break
    page++
  }

  return NextResponse.json(allUsers)
}

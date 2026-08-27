/**
 * One-off cleanup for a user whose user_profiles/app data was already
 * deleted in a prior partial run, but whose actual Supabase Auth account
 * is still orphaned (couldn't be deleted due to the message_threads FK
 * we discovered afterward).
 *
 * This looks the user up directly by email via the Auth admin API (not
 * via user_profiles, which is already gone), cleans up the messaging
 * tables that were blocking deletion, and finishes deleting the auth
 * account.
 */

const { createClient } = require('@supabase/supabase-js')

const EMAIL = 'anassar@icpcnj.org'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function main() {
  // Find the orphaned auth user directly (not via user_profiles, which is gone)
  const { data: userList, error: listErr } = await supabase.auth.admin.listUsers()
  if (listErr) {
    console.log('Error listing users:', listErr.message)
    return
  }

  const user = userList.users.find(u => u.email?.toLowerCase() === EMAIL.toLowerCase())
  if (!user) {
    console.log(`No auth user found for ${EMAIL} - it may already be fully deleted.`)
    return
  }

  const userId = user.id
  console.log(`Found orphaned auth user: ${userId}`)

  // Clean up the messaging tables that blocked deletion last time
  const messagingTables = [
    { table: 'message_read_status', column: 'user_id' },
    { table: 'message_deletions', column: 'user_id' },
    { table: 'thread_messages', column: 'sender_id' },
    { table: 'thread_participants', column: 'user_id' },
    { table: 'message_threads', column: 'created_by' },
    { table: 'blog_posts', column: 'author_id' },
  ]

  for (const { table, column } of messagingTables) {
    const { count } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, userId)
    if (count && count > 0) {
      console.log(`  Deleting ${count} row(s) from ${table}...`)
      const { error } = await supabase.from(table).delete().eq(column, userId)
      if (error) console.log(`  ⚠️  ${error.message}`)
    }
  }

  // Now try deleting the auth account again
  const { error: deleteErr } = await supabase.auth.admin.deleteUser(userId)
  if (deleteErr) {
    console.log(`❌ Still failed: ${deleteErr.message}`)
    console.log('There may be another table with a foreign key we haven\'t found yet.')
  } else {
    console.log(`✅ Successfully deleted the orphaned auth account. Email is now free.`)
  }
}

main()

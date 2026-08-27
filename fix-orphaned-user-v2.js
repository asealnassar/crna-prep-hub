/**
 * Targeted cleanup using the known user ID directly (avoids the pagination
 * bug in the previous script, which used listUsers() and silently missed
 * this user because they weren't on the first page of results).
 */

const { createClient } = require('@supabase/supabase-js')

const USER_ID = '250671fa-bfba-4768-bf80-e206b27d6c4b'
const EMAIL = 'anassar@icpcnj.org'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function main() {
  console.log(`Cleaning up remaining data for ${EMAIL} (${USER_ID})...`)

  // Clean up every table that could still be referencing this user,
  // including ones outside the original messaging list, in case there's
  // still something else blocking deletion.
  const allTables = [
    { table: 'saved_schools', column: 'user_id' },
    { table: 'user_asked_questions', column: 'user_id' },
    { table: 'gpa_calculations', column: 'user_id' },
    { table: 'applications', column: 'user_id' },
    { table: 'documents', column: 'user_id' },
    { table: 'interview_sessions', column: 'user_id' },
    { table: 'user_read_updates', column: 'user_id' },
    { table: 'resumes', column: 'user_id' },
    { table: 'raffle_submissions', column: 'user_id' },
    { table: 'forum_post_views', column: 'user_id' },
    { table: 'forum_replies', column: 'user_id' },
    { table: 'forum_posts', column: 'user_id' },
    { table: 'school_unlock_requests', column: 'user_id' },
    { table: 'user_lesson_progress', column: 'user_id' },
    { table: 'message_read_status', column: 'user_id' },
    { table: 'message_deletions', column: 'user_id' },
    { table: 'thread_messages', column: 'sender_id' },
    { table: 'thread_participants', column: 'user_id' },
    { table: 'message_threads', column: 'created_by' },
    { table: 'blog_posts', column: 'author_id' },
  ]

  for (const { table, column } of allTables) {
    const { count, error: checkErr } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(column, USER_ID)
    if (checkErr) continue // column/table might not exist, skip silently
    if (count && count > 0) {
      console.log(`  Deleting ${count} row(s) from ${table}...`)
      const { error } = await supabase.from(table).delete().eq(column, USER_ID)
      if (error) console.log(`  ⚠️  ${error.message}`)
    }
  }

  // Also delete user_profiles in case it somehow still exists
  await supabase.from('user_profiles').delete().eq('id', USER_ID)

  console.log('\nAttempting to delete the auth account...')
  const { data, error: deleteErr } = await supabase.auth.admin.deleteUser(USER_ID)
  if (deleteErr) {
    console.log(`❌ FAILED: ${deleteErr.message}`)
    console.log('Full error object:', JSON.stringify(deleteErr, null, 2))
  } else {
    console.log(`✅ Delete call succeeded (verify with SQL query afterward, don't just trust this)`)
  }
}

main()

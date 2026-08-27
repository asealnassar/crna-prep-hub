/**
 * One-time manual account deactivation script (v3 - corrected table list).
 *
 * Usage:
 *   1. Fill in the EMAILS_TO_DEACTIVATE array below.
 *   2. Dry run first (default, nothing is sent or deleted):
 *        node --env-file=.env.local deactivate-users.js
 *   3. Only once reviewed, run for real:
 *        node --env-file=.env.local deactivate-users.js --confirm
 *
 * Table list below was built from querying pg_constraint directly for every
 * foreign key pointing at auth.users(id) - this is the authoritative list,
 * not a guess. auth.* internal tables (sessions, identities, mfa_factors,
 * etc.) are NOT included here since Supabase's admin.deleteUser() handles
 * cleaning those up automatically as part of deleting the auth user itself.
 */

const { createClient } = require('@supabase/supabase-js')
const { Resend } = require('resend')

// ============================================================
// FILL THIS IN with the exact emails you decided to deactivate
// ============================================================
const EMAILS_TO_DEACTIVATE = [
  'pmathai4505@gmail.com',
  'abysindhu@yahoo.com',
  'lisaspon@yahoo.com',
  'maxmurdockrocks@gmail.com',
  'paoladavefev@gmail.com',
  'j_thach@yahoo.com',
  'odigiestacy@yahoo.com',
  'henrymuloki1@gmail.com',
  'kristyfrancois503@gmail.com',
  'victor.burciaga17@gmail.com',
  'marissanye327@gmail.com',
  'davidngugi93@gmail.com',
  'beathamsafiri@gmail.com',
  'magical.urmom@gmail.com',
  '18carriec@gmail.com',
  'cleayamantes@gmail.com',
  'jamesseybert3@gmail.com',
  'moman103@yahoo.com',
  'rjvoos98@gmail.com',
  'masonz53@outlook.com',
  'juliezopp@gmail.com',
  'tiffbsn18@gmail.com',
  'lscally.817@gmail.com',
  'samantha.haney26@gmail.com',
  'crystalbeans234@gmail.com',
  'lianayisell@yahoo.es',
  'nivadeshommes@yahoo.com',
  'nivacarlette@gmail.com',
  'kv32smith@gmail.com',
  'livlaravie@gmail.com',
  'foliviapfeifer@gmail.com',
  'nextstepcrna@gmail.com',
  'kbaton96@gmail.com',
  'ljkochan@gmail.com',
  'baileymcdonald36@yahoo.com',
  'vgh@gmail.com',
  'lorabulut@gmail.com',
  'f390228@gmail.com',
  'ghook14@gmail.com',
  'atxpz30@gmail.com',
  'hailey.clouse@yahoo.com',
  'ava.adams15@gmail.com',
  'tripp1662@icloud.com',
  'kdpalmer10@gmail.com',
  'warrenjuniorhigh123@gmail.com',
  'ali.rmaite1012@gmail.com',
  'tyguyshurtz@gmail.com',
  'lanemayson@yahoo.com',
  'jessicamvhart@gmail.com',
  'tuanhnong2901@gmail.com',
  'savhaner98@gmail.com',
  'josh.lemming24@gmail.com',
  'jeanetstephenson75@gmail.com',
  'yzbyrak@gmail.com',
  'chase.berry1014@yahoo.com',
  'jlynnbrady@gmail.com',
  'savannahq22@yahoo.com',
  'jonngh98@gmail.com',
  'adamcohen18@gmail.com',
  'lindsey.ide2@gmail.com',
  'kylieh.209@gmail.com',
  'nicolakloss@gmail.com',
  'kayleskylarb@yahoo.com',
  'joshuarut23@gmail.com',
  'eleanor.l.pearl@gmail.com',
  'banderson9998@gmail.com',
  'trucchi.ht@gmail.com',
  'geanetteboggs@gmail.com',
  'christensen.caydenc@gmail.com',
  'chocolateoreos99@gmail.com',
  'savannah.caplan@gmail.com',
  'vastib@sbcglobal.net',
  'unguyenkim@gmail.com',
  'isaiahrupp99@gmail.com',
  'pbdiaz86@gmail.com',
  'kdoodhnauth@gmail.com',
  'breez.5683@yahoo.com',
  'ewdfefef@gmail.com',
  'delynneckert1@gmail.com',
  'rachel.rogers1996@aol.com',
  'alwayshk13@gmail.com',
  'sjpeddicord2002@gmail.com',
  'cjacks36@yahoo.com',
  'chisom4u.okoye@yahoo.com',
  'baileyfreeman97@yahoo.com',
  'tyqueenm@gmail.com',
  'tcoulterrn@gmail.com',
  'mohammad.c7227@gmail.com',
  'riosdannyg@gmail.com',
  'avery.mcgee0308@gmail.com',
  'mztelly@yahoo.com',
  'benunez153@gmail.com',
  'steelmanjacob@yahoo.com',
  'anthonysnyder23@gmail.com',
  'iamshahir.h@gmail.com',
  'dfdfgdfgb@gmail.com',
  'rhno.fiit@gmail.com',
  'greg01357@aim.com',
  'kyarapolanco99@gmail.com',
  'mahir143u@gmail.com',
  'espinosadiamond@gmail.com',
  'reecewiggins896@gmail.com',
  'aboodie61@gmail.com',
  'buckeyemk@icloud.com',
  'wballard2003@icloud.com',
  'sofia.nicolas@lc.cuny.edu',
  'mstikyraj@gmail.com',
]

const isConfirmed = process.argv.includes('--confirm')

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const resend = new Resend(process.env.RESEND_API_KEY)

// { table, column } pairs, in deletion order: messaging "child" rows before
// message_threads itself, everything else before user_profiles.
const USER_DATA_TABLES = [
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
  // Messaging - deleted in this order to avoid FK errors within these tables
  { table: 'message_read_status', column: 'user_id' },
  { table: 'message_deletions', column: 'user_id' },
  { table: 'thread_messages', column: 'sender_id' },
  { table: 'thread_participants', column: 'user_id' },
  { table: 'message_threads', column: 'created_by' },
  // Public content - flagged for awareness, see note printed below
  { table: 'blog_posts', column: 'author_id' },
]

const EMAIL_SUBJECT = "Your CRNA Prep Hub account has been deactivated"

const EMAIL_HTML = (email) => `
<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #4c1d95;">Your account has been deactivated</h2>
  <p style="color: #374151; line-height: 1.6;">
    Hi there,
  </p>
  <p style="color: #374151; line-height: 1.6;">
    Your free CRNA Prep Hub account associated with this email address has been
    deactivated due to inactivity. Your account and any associated data have
    been removed from our system.
  </p>
  <p style="color: #374151; line-height: 1.6;">
    You're welcome to sign up again at any time in the future if you'd like to
    use CRNA Prep Hub going forward.
  </p>
  <p style="color: #374151; line-height: 1.6;">
    <a href="https://crnaprephub.com/signup" style="color: #7c3aed; font-weight: 600;">
      Sign up again →
    </a>
  </p>
  <p style="color: #9ca3af; font-size: 13px; margin-top: 32px;">
    CRNA Prep Hub
  </p>
</div>
`

async function processUser(email) {
  console.log(`\n--- ${email} ---`)

  const { data: profile, error: profileErr } = await supabase
    .from('user_profiles')
    .select('id, email, subscription_tier')
    .eq('email', email)
    .maybeSingle()

  if (profileErr || !profile) {
    console.log(`  ⚠️  No profile found for this email - skipping`)
    return
  }

  if (profile.subscription_tier !== 'free') {
    console.log(`  ⚠️  This user is tier "${profile.subscription_tier}", not free - skipping as a safety precaution`)
    return
  }

  const userId = profile.id
  console.log(`  Found user_id: ${userId}`)

  if (!isConfirmed) {
    console.log(`  [DRY RUN] Would send deactivation email to ${email}`)
    for (const { table, column } of USER_DATA_TABLES) {
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(column, userId)
      if (error) {
        console.log(`  [DRY RUN] ⚠️  Could not check ${table}.${column}: ${error.message}`)
      } else if (count && count > 0) {
        const flag = table === 'blog_posts' || table === 'message_threads'
          ? '  ⚠️  PUBLIC/SHARED CONTENT - review before confirming'
          : ''
        console.log(`  [DRY RUN] Would delete ${count} row(s) from ${table}${flag}`)
      }
    }
    console.log(`  [DRY RUN] Would delete user_profiles row`)
    console.log(`  [DRY RUN] Would delete auth user (frees up email for future signup)`)
    return
  }

  // --- REAL RUN below this point ---

  try {
    await resend.emails.send({
      from: 'notifications@crnaprephub.com',
      to: email,
      subject: EMAIL_SUBJECT,
      html: EMAIL_HTML(email),
    })
    console.log(`  ✅ Notification email sent`)
  } catch (err) {
    console.log(`  ❌ Failed to send email: ${err.message} - continuing with deletion anyway`)
  }

  for (const { table, column } of USER_DATA_TABLES) {
    const { error } = await supabase.from(table).delete().eq(column, userId)
    if (error) {
      console.log(`  ⚠️  Error deleting from ${table}: ${error.message}`)
    }
  }
  console.log(`  ✅ Deleted app data`)

  const { error: profileDeleteErr } = await supabase
    .from('user_profiles')
    .delete()
    .eq('id', userId)
  if (profileDeleteErr) {
    console.log(`  ⚠️  Error deleting user_profiles: ${profileDeleteErr.message}`)
  } else {
    console.log(`  ✅ Deleted user_profiles row`)
  }

  const { error: authDeleteErr } = await supabase.auth.admin.deleteUser(userId)
  if (authDeleteErr) {
    console.log(`  ❌ Error deleting auth user: ${authDeleteErr.message}`)
    console.log(`  ⚠️  This user is now in a PARTIALLY DELETED state - app data and profile are gone, but their login still exists. Needs manual follow-up.`)
  } else {
    console.log(`  ✅ Deleted auth account - email is now free for a future signup`)
  }
}

async function main() {
  if (EMAILS_TO_DEACTIVATE.length === 0) {
    console.log('No emails in EMAILS_TO_DEACTIVATE - edit the script and add the list first.')
    return
  }

  console.log(isConfirmed
    ? `Running for REAL on ${EMAILS_TO_DEACTIVATE.length} user(s). This will send emails and permanently delete data.`
    : `DRY RUN on ${EMAILS_TO_DEACTIVATE.length} user(s). Nothing will actually be sent or deleted. Add --confirm to run for real.`
  )

  for (const email of EMAILS_TO_DEACTIVATE) {
    await processUser(email.trim().toLowerCase())
  }

  console.log('\nDone.')
}

main()

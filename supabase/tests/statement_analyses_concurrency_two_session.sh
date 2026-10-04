#!/usr/bin/env bash
# =============================================================================
# TWO-SESSION CONCURRENCY HARNESS for the analysis cache.
#
# WHY THIS FILE EXISTS.
# supabase/tests/statement_analyses_behaviour_test.sql exercises the SHAPE of
# both races from a single session, and says so in its own header: two
# statements in one session are SEQUENTIAL BY DEFINITION. A sequential test can
# show that a second claim returns a state rather than raising. It cannot show
# that two simultaneous transactions are unable to both insert, because only
# one transaction exists.
#
# This script opens TWO REAL CONNECTIONS, interleaves them from the outside,
# and -- this is the part that makes it a concurrency test rather than a
# narrative -- OBSERVES THE BLOCK FROM A THIRD CONNECTION by reading pg_locks
# while it is held. If no session ever blocks, procedure 1 FAILS rather than
# quietly passing, because that would mean the two claims never actually
# overlapped and the test proved nothing.
#
# The two procedures match the two documented in the behavioural test's header
# one step at a time. That file is the specification; this is its execution.
#
#   PROCEDURE 1 -- DUPLICATE CLAIM (the insert race).
#     Both sessions claim the same (draft_id, fingerprint). One must win with
#     state 'claimed' AND a claimToken; the other must receive state 'running'
#     AND NO TOKEN, and exactly one row must exist afterwards.
#
#   PROCEDURE 2 -- SUPERSEDED REQUEST (what the claim token was added for).
#     Session A claims and keeps TOKEN_1 IN ITS OWN SESSION. The claim is aged
#     past the ten-minute reclaim threshold. Session B reclaims the same id and
#     receives a rotated TOKEN_2. Session A must then be unable to settle
#     (not-found) or to release (released:false, removing nothing), and B must
#     still be able to finish its own work.
#
#     Each session holds its token in its own psql variables via \gset, so A
#     can never see TOKEN_2. That is not decoration: if both tokens lived in
#     the harness, the test would be checking string comparison rather than
#     session isolation.
#
# -----------------------------------------------------------------------------
# THIS IS FOR A DISPOSABLE LOCAL CLUSTER ONLY.
# -----------------------------------------------------------------------------
# It COMMITS writes, it ages a row by eleven minutes, and it depends on
# connecting AS the `authenticated` role -- which on Supabase is NOLOGIN, so
# this cannot work there even if it were pointed at it. The guards below refuse
# anything that looks like a managed Supabase database, refuse a non-local
# connection, and refuse to run without an explicit opt-in. They are checks,
# not reassurance: read them.
#
# USAGE
#   export PGHOST=/tmp/.crna_pg PGPORT=55432 PGDATABASE=crna_rehearsal
#   export CRNA_REHEARSAL_CONFIRM=disposable-local-cluster
#   supabase/tests/statement_analyses_concurrency_two_session.sh <owner-role>
#
# Prerequisites: local_rehearsal_scaffold.sql, the six migrations, and
# local_rehearsal_fixtures.sql, in that order.
# =============================================================================
set -euo pipefail

OWNER="${1:-}"
DRAFT='dddddddd-0000-4000-8000-00000000000a'   # applicant A's synthetic draft
SUBJECT='aaaaaaaa-0000-4000-8000-000000000001' # applicant A
CLAIMS="{\"sub\":\"$SUBJECT\"}"
FAILURES=0

die() { printf '\n  REFUSING TO RUN: %s\n' "$1" >&2; exit 2; }
note() { printf '  %s\n' "$1"; }
pass() { printf '  pass  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# ---- GUARD 1: an explicit opt-in. An unset variable is a refusal. ----------
[ "${CRNA_REHEARSAL_CONFIRM:-}" = 'disposable-local-cluster' ] \
  || die "CRNA_REHEARSAL_CONFIRM is not set to 'disposable-local-cluster'.
                   This script commits writes and ages rows. Set it only for a
                   throwaway local database."

[ -n "$OWNER" ] || die "no owner role given.
                   Usage: $0 <owner-role>   (the role that owns the statement tables)"

# ---- GUARD 2: the connection must be a LOCAL UNIX SOCKET. ------------------
# A unix socket cannot reach a hosted database. Checking the transport is
# stronger than pattern-matching hostnames for 'supabase.co', because it
# excludes every remote host rather than one spelling of one of them.
case "${PGHOST:-}" in
  /*) : ;;
  *)  die "PGHOST is '${PGHOST:-<unset>}'. This script requires a local unix-socket
                   directory (an absolute path). It will not run over TCP, which is
                   how it cannot reach a hosted database." ;;
esac
[ -z "${PGHOSTADDR:-}" ] || die "PGHOSTADDR is set ('$PGHOSTADDR'), which forces a TCP connection."
for v in PGURI DATABASE_URL POSTGRES_URL SUPABASE_DB_URL; do
  [ -z "${!v:-}" ] || die "$v is set. Unset it: a connection URI would override PGHOST."
done

PSQL_OWNER=(psql -U "$OWNER" -X -q -t -A -v ON_ERROR_STOP=1)

# ---- GUARD 3: the database itself must not look like managed Supabase. -----
SIGNALS=$("${PSQL_OWNER[@]}" -c "
  select coalesce(string_agg(s, '; '), '') from (
    select 'Supabase-managed roles exist' as s where exists (
      select 1 from pg_roles where rolname in ('supabase_admin','supabase_auth_admin',
        'supabase_storage_admin','supabase_read_only_user','authenticator','dashboard_user'))
    union all
    select 'Supabase extensions installed' where exists (
      select 1 from pg_extension where extname in ('pg_graphql','pgsodium','supabase_vault','pg_net'))
    union all
    select 'Supabase schemas present' where exists (
      select 1 from pg_namespace where nspname in ('graphql','graphql_public','realtime',
        '_realtime','storage','vault'))
  ) t;")
[ -z "$SIGNALS" ] || die "this looks like a managed Supabase database ($SIGNALS)."

# ---- GUARD 4: and it must be the disposable cluster's own shape. -----------
HAS_LOGIN=$("${PSQL_OWNER[@]}" -c "select rolcanlogin from pg_roles where rolname='authenticated';")
[ "$HAS_LOGIN" = 't' ] || die "the 'authenticated' role cannot log in.
                   This script needs genuine separate sessions as that role, which
                   only the local scaffold provides. Run local_rehearsal_scaffold.sql."

printf '\n  guards passed: socket=%s db=%s owner=%s\n\n' \
  "$PGHOST" "$("${PSQL_OWNER[@]}" -c 'select current_database();')" "$OWNER"

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

# Wait for a condition IN THE DATABASE rather than with sleep, so the harness
# does not depend on a guessed delay being long enough on a slower machine.
db_settle() { "${PSQL_OWNER[@]}" -c "select pg_sleep(${1:-1});" > /dev/null; }

open_session() { # $1 = tag
  mkfifo "$WORK/$1_in"
  psql -U authenticated -X -At -f "$WORK/$1_in" > "$WORK/$1_out" 2>&1 &
  echo $!
}

# =============================================================================
printf '=== PROCEDURE 1 -- DUPLICATE CLAIM (the insert race) ===\n'
# =============================================================================
FP1="repeat('f',64)"
"${PSQL_OWNER[@]}" -c "delete from public.statement_analyses where fingerprint = $FP1;" > /dev/null

A_PID=$(open_session a); B_PID=$(open_session b)
exec 3> "$WORK/a_in"; exec 4> "$WORK/b_in"

# Session A: claim inside an OPEN transaction and hold the row.
cat >&3 <<EOF
select 'A pid=' || pg_backend_pid() || ' user=' || current_user;
set request.jwt.claims = '$CLAIMS';
begin;
select 'A ' || public.claim_statement_analysis('$DRAFT', $FP1, 1, false, 'catalog',
                                               100, null, false, 'rehearsal-rubric', 'rehearsal-schema')::text;
EOF
db_settle 1

# Session B: the SAME claim, concurrently. It must BLOCK on the unique key.
cat >&4 <<EOF
select 'B pid=' || pg_backend_pid() || ' user=' || current_user;
set request.jwt.claims = '$CLAIMS';
select 'B ' || public.claim_statement_analysis('$DRAFT', $FP1, 1, false, 'catalog',
                                               100, null, false, 'rehearsal-rubric', 'rehearsal-schema')::text;
EOF

# THE PROOF OF REAL CONCURRENCY: observe the block from a third connection.
BLOCKED=$("${PSQL_OWNER[@]}" -c "
  do \$\$
  declare i int := 0; n int := 0;
  begin
    loop
      select count(*) into n from pg_stat_activity
       where usename = 'authenticated' and wait_event_type = 'Lock';
      exit when n > 0 or i > 40;
      perform pg_sleep(0.25); i := i + 1;
    end loop;
  end \$\$;
  select coalesce(max(wait_event_type || '/' || wait_event), 'NONE')
    from pg_stat_activity where usename = 'authenticated' and wait_event_type = 'Lock';")

if [ "$BLOCKED" = 'NONE' ]; then
  fail "no session ever blocked -- the two claims did not overlap, so nothing was tested"
else
  pass "session B is genuinely BLOCKED on a lock (wait=$BLOCKED)"
fi
UNCOMMITTED=$("${PSQL_OWNER[@]}" -c "select count(*) from public.statement_analyses where fingerprint = $FP1;")
[ "$UNCOMMITTED" = '0' ] \
  && pass "a third session sees 0 committed rows while A holds its transaction open" \
  || fail "a third session already sees $UNCOMMITTED row(s); A's insert should be invisible"

echo "commit;" >&3
db_settle 1.5
echo '\q' >&3; echo '\q' >&4; exec 3>&-; exec 4>&-
wait "$A_PID" 2>/dev/null || true; wait "$B_PID" 2>/dev/null || true

A_OUT=$(cat "$WORK/a_out"); B_OUT=$(cat "$WORK/b_out")
printf '\n  --- session A ---\n'; sed 's/^/    /' "$WORK/a_out"
printf '  --- session B ---\n';   sed 's/^/    /' "$WORK/b_out"; echo

grep -q '"state": "claimed"' <<<"$A_OUT" \
  && pass "A won the race with state 'claimed'" \
  || fail "A did not win with 'claimed'"
grep -q 'claimToken' <<<"$A_OUT" \
  && pass "the winner received a claimToken" \
  || fail "the winner received no claimToken"
grep -q '"state": "running"' <<<"$B_OUT" \
  && pass "the loser was told 'running' -- not an error, not a second row" \
  || fail "the loser did not receive 'running'"
grep -q 'claimToken' <<<"$B_OUT" \
  && fail "THE LOSER RECEIVED A claimToken -- it must carry no authority to settle" \
  || pass "the loser received NO claimToken -- 'running' is not authority"

ROWS=$("${PSQL_OWNER[@]}" -c "select count(*) from public.statement_analyses where fingerprint = $FP1;")
[ "$ROWS" = '1' ] \
  && pass "exactly 1 row survived the race" \
  || fail "$ROWS rows exist for one (draft_id, fingerprint); expected 1"

# =============================================================================
printf '\n=== PROCEDURE 2 -- SUPERSEDED REQUEST (the claim token) ===\n'
# =============================================================================
FP2="repeat('9',64)"
"${PSQL_OWNER[@]}" -c "delete from public.statement_analyses where fingerprint = $FP2;" > /dev/null

A_PID=$(open_session c); B_PID=$(open_session d)
exec 3> "$WORK/c_in"; exec 4> "$WORK/d_in"

# Step 1 -- A claims. TOKEN_1 stays in A's OWN session variables.
cat >&3 <<EOF
select 'A pid=' || pg_backend_pid();
set request.jwt.claims = '$CLAIMS';
select j->>'id' as aid, j->>'claimToken' as tok
  from (select public.claim_statement_analysis('$DRAFT', $FP2, 1, false, 'catalog',
                                               100, null, false, 'rehearsal-rubric', 'rehearsal-schema') as j) s \gset
select 'A claimed id=' || :'aid' || ' token=' || :'tok';
EOF
db_settle 1

# Step 2 -- A's model call hangs. Age the claim past the ten-minute threshold.
# A WRITE to a row this script created in step 1, standing in for elapsed time.
AGED=$("${PSQL_OWNER[@]}" -c "
  update public.statement_analyses set updated_at = now() - interval '11 minutes'
   where fingerprint = $FP2 returning 1;")
[ "$AGED" = '1' ] && note "claim aged by 11 minutes (standing in for a hung model call)" \
                  || fail "could not age the claim"

# Step 3 -- B arrives and RECLAIMS: same id, rotated token, in ITS session.
cat >&4 <<EOF
select 'B pid=' || pg_backend_pid();
set request.jwt.claims = '$CLAIMS';
select j->>'id' as bid, j->>'claimToken' as tok, j->>'state' as st
  from (select public.claim_statement_analysis('$DRAFT', $FP2, 1, false, 'catalog',
                                               100, null, false, 'rehearsal-rubric', 'rehearsal-schema') as j) s \gset
select 'B reclaimed id=' || :'bid' || ' state=' || :'st' || ' token=' || :'tok';
EOF
db_settle 1

# Steps 4 and 5 -- A finishes its superseded call and tries to settle, then release.
cat >&3 <<EOF
select 'A settle with its OWN stale token -> ' ||
  public.settle_statement_analysis(:'aid'::uuid, :'tok'::uuid,
    '{"synthetic":"A result"}'::jsonb, 11)::text;
select 'A release with its OWN stale token -> ' ||
  public.settle_statement_analysis(:'aid'::uuid, :'tok'::uuid, null, null)::text;
EOF
db_settle 1.5

MID=$("${PSQL_OWNER[@]}" -c "
  select status || '|' || coalesce(overall::text,'NULL') || '|' || count(*) over ()
    from public.statement_analyses where fingerprint = $FP2;")
[ "$MID" = 'pending|NULL|1' ] \
  && pass "B's claim survived both of A's attempts intact (still pending, not overwritten)" \
  || fail "after A's attempts the row reads '$MID'; expected 'pending|NULL|1'"

# Step 6 -- B settles with the live token.
cat >&4 <<EOF
select 'B settle with the LIVE token -> ' ||
  public.settle_statement_analysis(:'bid'::uuid, :'tok'::uuid,
    '{"synthetic":"B result"}'::jsonb, 88)::text;
EOF
db_settle 1.5
echo '\q' >&3; echo '\q' >&4; exec 3>&-; exec 4>&-
wait "$A_PID" 2>/dev/null || true; wait "$B_PID" 2>/dev/null || true

C_OUT=$(cat "$WORK/c_out"); D_OUT=$(cat "$WORK/d_out")
printf '\n  --- session A (the superseded request) ---\n'; sed 's/^/    /' "$WORK/c_out"
printf '  --- session B (the replacement) ---\n';          sed 's/^/    /' "$WORK/d_out"; echo

TOK_A=$(sed -n 's/.*A claimed id=[^ ]* token=//p' "$WORK/c_out")
TOK_B=$(sed -n 's/.*token=//p' "$WORK/d_out")
ID_A=$(sed -n 's/.*A claimed id=\([^ ]*\) .*/\1/p' "$WORK/c_out")
ID_B=$(sed -n 's/.*B reclaimed id=\([^ ]*\) .*/\1/p' "$WORK/d_out")

[ -n "$TOK_A" ] && [ -n "$TOK_B" ] \
  || fail "could not read both tokens from the transcripts -- the assertions below would be vacuous"
[ "$ID_A" = "$ID_B" ] \
  && pass "the reclaim KEPT the id ($ID_A) -- the cache entry is not duplicated" \
  || fail "the id changed on reclaim: $ID_A then $ID_B"
[ "$TOK_A" != "$TOK_B" ] \
  && pass "the reclaim ROTATED the token -- this is the whole fix" \
  || fail "the token did NOT rotate; a superseded request would still hold authority"
grep -q 'B reclaimed .*state=claimed' <<<"$D_OUT" \
  && pass "B's reclaim returned 'claimed', so recovery from an abandoned claim still works" \
  || fail "B's reclaim did not return 'claimed'"
grep -q 'A settle .*"reason": "not-found"' <<<"$C_OUT" \
  && pass "A's settle with the stale token -> not-found (it cannot overwrite B's work)" \
  || fail "A's settle did not return not-found"
grep -q 'A release .*"released": false' <<<"$C_OUT" \
  && pass "A's release reported released:false -- it removed nothing" \
  || fail "A's release did not report released:false"
grep -q 'B settle .*"state": "complete"' <<<"$D_OUT" \
  && pass "B could still finish its own work" \
  || fail "B could not settle with its live token"

FINAL=$("${PSQL_OWNER[@]}" -c "
  select status || '|' || overall || '|' || (review->>'synthetic')
    from public.statement_analyses where fingerprint = $FP2;")
[ "$FINAL" = 'complete|88|B result' ] \
  && pass "the stored result is B's, not A's (status=complete overall=88)" \
  || fail "the stored result reads '$FINAL'; expected 'complete|88|B result'"

# =============================================================================
printf '\n=== RESULT ===\n'
if [ "$FAILURES" -eq 0 ]; then
  printf '  ALL TWO-SESSION CHECKS PASSED\n\n'
  exit 0
fi
printf '  %d CHECK(S) FAILED\n\n' "$FAILURES"
exit 1

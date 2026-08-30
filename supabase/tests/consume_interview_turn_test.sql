-- ============================================================================
-- Rollback-safe behavioural test for public.consume_interview_turn().
--
-- Run AFTER 20260830_002_interview_grants.sql has been applied.
--
-- Every statement runs inside a transaction that ends in ROLLBACK, so nothing
-- is committed: the temporary grant row never becomes visible to any other
-- session and does not survive the test. No production row is read, modified
-- or deleted -- the fixture user id is generated, not borrowed from
-- auth.users, and the foreign key is satisfied by inserting a throwaway
-- auth.users row that is rolled back with everything else.
--
-- Read the NOTICE output, then confirm the final SELECT reports 0 rows.
-- ============================================================================
begin;

do $$
declare
  v_user  uuid := gen_random_uuid();
  v_grant uuid;
  v_result integer;
  v_failures integer := 0;
begin
  -- Fixture. Rolled back; never committed.
  insert into auth.users (id, instance_id, aud, role, email)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', format('rls-test-%s@example.invalid', v_user));

  insert into public.interview_grants (user_id, turns_used, completed)
  values (v_user, 0, false)
  returning id into v_grant;

  -- 1. A fresh grant reserves a turn and reports the new count.
  select public.consume_interview_turn(v_grant) into v_result;
  if v_result is distinct from 1 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  fresh grant: expected 1, got %', v_result;
  else
    raise notice 'pass  fresh grant reserved a turn (turns_used = 1)';
  end if;

  -- 2. At the cap, the reservation is refused and the counter does not move.
  update public.interview_grants set turns_used = 24 where id = v_grant;
  select public.consume_interview_turn(v_grant) into v_result;
  if v_result is not null then
    v_failures := v_failures + 1;
    raise notice 'FAIL  at cap: expected NULL, got %', v_result;
  else
    raise notice 'pass  reservation refused at the cap';
  end if;

  select turns_used into v_result from public.interview_grants where id = v_grant;
  if v_result is distinct from 24 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  counter moved past the cap: %', v_result;
  else
    raise notice 'pass  counter held at 24';
  end if;

  -- 3. One below the cap still succeeds, so the boundary is < and not <=.
  update public.interview_grants set turns_used = 23 where id = v_grant;
  select public.consume_interview_turn(v_grant) into v_result;
  if v_result is distinct from 24 then
    v_failures := v_failures + 1;
    raise notice 'FAIL  boundary: expected 24, got %', v_result;
  else
    raise notice 'pass  final turn allowed at 23 -> 24';
  end if;

  -- 4. A completed grant is refused regardless of the counter.
  update public.interview_grants set turns_used = 0, completed = true where id = v_grant;
  select public.consume_interview_turn(v_grant) into v_result;
  if v_result is not null then
    v_failures := v_failures + 1;
    raise notice 'FAIL  completed grant: expected NULL, got %', v_result;
  else
    raise notice 'pass  completed grant refused';
  end if;

  -- 5. An unknown id is refused rather than erroring.
  select public.consume_interview_turn(gen_random_uuid()) into v_result;
  if v_result is not null then
    v_failures := v_failures + 1;
    raise notice 'FAIL  unknown grant: expected NULL, got %', v_result;
  else
    raise notice 'pass  unknown grant refused';
  end if;

  if v_failures = 0 then
    raise notice '--- ALL CHECKS PASSED ---';
  else
    raise notice '--- % CHECK(S) FAILED ---', v_failures;
  end if;
end $$;

rollback;

-- Post-rollback confirmation. Expect 0 -- the fixture left nothing behind.
select count(*) as leftover_test_grants
from   public.interview_grants
where  interview_type is null and mode is null and created_at > now() - interval '5 minutes';

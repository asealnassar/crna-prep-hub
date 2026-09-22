-- ============================================================================
-- Interview length: Quick Mock (5 primary questions) or Full Mock (10).
--
-- The length is decided once, by the server, when an interview starts, and is
-- recorded HERE -- on the grant, which only the service role can write -- so
-- that no later request, edited state or refresh can change it. The browser's
-- copy of the engine state carries a length too, but only as a claim: every
-- turn and every resume applies the grant's value over it
-- (lib/interview/authority.ts).
--
-- Additive and backward-compatible: the application deployed today (e0b5471)
-- never names this column, so it keeps working unchanged on either side of
-- this migration. Apply it BEFORE the Phase 3 code, as with Resume.
-- ============================================================================

-- smallint, because the only values it will ever hold are 5 and 10.
--
-- NULLABLE with NO DEFAULT, deliberately:
--   * NULL means "issued before this column existed", and every such grant was
--     a ten-question interview. The application reads NULL as Full.
--   * No default keeps that meaning honest for the grants the CURRENTLY
--     DEPLOYED code goes on issuing after this runs: it does not know the
--     column, so its grants stay NULL and stay Full. A DEFAULT 10 would stamp
--     them as explicit Phase 3 grants instead -- and Phase 3 holds explicit
--     grants to follow-up policy V2, which would switch an interview already
--     running under V1 rules in the middle of the session.
--   * No backfill, for the same reason: historical grants are NULL and mean
--     Full without a single row being rewritten.
--
-- The CHECK is the database's half of "only 5 or 10"; the start request is
-- validated in the application before any grant is written. NULL is named in
-- it explicitly because NULL is the historical case, not an accident. Declared
-- inline, so that on a re-run `add column if not exists` skips the constraint
-- together with the column rather than failing on a duplicate name.
alter table public.interview_grants
  add column if not exists max_primary_questions smallint
    constraint interview_grants_max_primary_questions_check
    check (max_primary_questions is null or max_primary_questions in (5, 10));

-- Nothing else. No index (the column is only ever read alongside a row fetched
-- by primary key), no RLS or policy change (interview_grants stays service-role
-- only), no grant change (service_role's table-level privileges already cover a
-- new column), no function change (consume_interview_turn keeps its 24-turn
-- ceiling for every grant).

-- Statement Drafts (Phase 3) -- POST-MIGRATION VERIFICATION. READ-ONLY.
-- Run immediately after supabase/migrations/20260928_000_statement_drafts.sql.
--
-- ONE STATEMENT, deliberately: the Supabase SQL editor shows only the LAST
-- result of a multi-statement script, so every check below is unioned into a
-- single query and the whole matrix is visible at once.
--
-- PASS CONDITION: every row reads PASS, except the rows marked INFO, which are
-- context rather than assertions. A single FAIL means the migration did not land
-- as designed -- do not build on it.
--
-- to_regclass() is used rather than a ::regclass cast so that a missing table
-- reports as one clean FAIL instead of aborting the whole query. For the same
-- reason has_table_privilege() is called with the table OID rather than its
-- name: given a NULL oid it returns NULL, whereas the name form raises
-- 'relation does not exist' and would abort every other check with it.
--
-- Mutates nothing.

with
tbl as (select to_regclass('public.statement_drafts') as oid),

expected_cols(ord, col, typ, nullable, def_pattern, def_note) as (
  values
    (1, 'id',         'uuid',                     'NO', 'gen_random_uuid', 'gen_random_uuid()'),
    (2, 'user_id',    'uuid',                     'NO', null::text,        '(none)'),
    (3, 'title',      'text',                     'NO', null::text,        '(none)'),
    (4, 'essay',      'text',                     'NO', '::text',          'empty string'),
    (5, 'revision',   'bigint',                   'NO', '^1',              '1'),
    (6, 'created_at', 'timestamp with time zone', 'NO', 'now',             'now()'),
    (7, 'updated_at', 'timestamp with time zone', 'NO', 'now',             'now()')
),

expected_policies(ord, pname, cmd) as (
  values
    (1, 'own statement draft select', 'SELECT'),
    (2, 'own statement draft insert', 'INSERT'),
    (3, 'own statement draft update', 'UPDATE'),
    (4, 'own statement draft delete', 'DELETE')
),

checks(step, check_name, actual, expected, verdict) as (

  -- ---- 1. the table -------------------------------------------------
  select 1, 'table public.statement_drafts',
         case when (select oid from tbl) is null then 'MISSING' else 'present' end,
         'present',
         case when (select oid from tbl) is null then 'FAIL' else 'PASS' end

  -- ---- 2. columns: type, nullability, default -----------------------
  union all
  select 100 + e.ord,
         'column ' || e.col,
         coalesce(c.data_type, '(missing)') || ' / ' ||
           coalesce(c.is_nullable, '?') || ' / ' ||
           coalesce(c.column_default, '(none)'),
         e.typ || ' / ' || e.nullable || ' / ' || e.def_note,
         case
           when c.column_name is null then 'FAIL -- missing'
           when c.data_type <> e.typ then 'FAIL -- type'
           when c.is_nullable <> e.nullable then 'FAIL -- nullability'
           when e.def_pattern is null and c.column_default is not null then 'FAIL -- unexpected default'
           when e.def_pattern is not null
                and coalesce(c.column_default, '') !~ e.def_pattern then 'FAIL -- default'
           else 'PASS'
         end
  from expected_cols e
  left join information_schema.columns c
    on c.table_schema = 'public' and c.table_name = 'statement_drafts'
   and c.column_name = e.col

  -- ---- 3. no columns beyond the seven -------------------------------
  union all
  select 200, 'no unexpected columns',
         coalesce((select string_agg(c.column_name, ', ' order by c.ordinal_position)
                     from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = 'statement_drafts'
                      and c.column_name not in
                          ('id','user_id','title','essay','revision','created_at','updated_at')),
                  'none'),
         'none -- exactly seven columns',
         case when exists (select 1 from information_schema.columns c
                            where c.table_schema = 'public' and c.table_name = 'statement_drafts'
                              and c.column_name not in
                                  ('id','user_id','title','essay','revision','created_at','updated_at'))
              then 'FAIL' else 'PASS' end

  -- ---- 4. primary key ----------------------------------------------
  union all
  select 300, 'primary key',
         coalesce((select pg_get_constraintdef(con.oid) from pg_constraint con
                    where con.conrelid = (select oid from tbl) and con.contype = 'p'), '(none)'),
         'PRIMARY KEY (id)',
         case when exists (select 1 from pg_constraint con
                            where con.conrelid = (select oid from tbl) and con.contype = 'p'
                              and pg_get_constraintdef(con.oid) ~ '^PRIMARY KEY \(id\)$')
              then 'PASS' else 'FAIL' end

  -- ---- 5. FK to auth.users, with cascade ---------------------------
  union all
  select 400, 'FK user_id -> auth.users ON DELETE CASCADE',
         coalesce((select pg_get_constraintdef(con.oid) from pg_constraint con
                    where con.conrelid = (select oid from tbl) and con.contype = 'f'), '(none)'),
         'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
         case when exists (select 1 from pg_constraint con
                            where con.conrelid = (select oid from tbl) and con.contype = 'f'
                              and pg_get_constraintdef(con.oid) ~ 'FOREIGN KEY \(user_id\)'
                              and pg_get_constraintdef(con.oid) ~ 'auth\.users\(id\)'
                              and pg_get_constraintdef(con.oid) ~ 'ON DELETE CASCADE')
              then 'PASS' else 'FAIL' end

  -- ---- 6. the three CHECK constraints ------------------------------
  --      char_length() is an alias for length(), so Postgres renders the
  --      definitions with length(); the patterns accept either spelling.
  union all
  select 500, 'check statement_drafts_revision_positive',
         coalesce((select pg_get_constraintdef(oid) || '   [digits: ' ||
                          regexp_replace(pg_get_constraintdef(oid), '[^0-9]', '', 'g') || ']'
                     from pg_constraint
                    where conrelid = (select oid from tbl)
                      and conname = 'statement_drafts_revision_positive'), '(none)'),
         'CHECK (revision >= 1)   [digits: 1]',
         case when exists (select 1 from pg_constraint
                            where conrelid = (select oid from tbl)
                              and conname = 'statement_drafts_revision_positive'
                              and pg_get_constraintdef(oid) ~ 'revision >= 1'
                              and regexp_replace(pg_get_constraintdef(oid), '[^0-9]', '', 'g') = '1')
              then 'PASS' else 'FAIL' end

  union all
  select 501, 'check statement_drafts_essay_length',
         coalesce((select pg_get_constraintdef(oid) || '   [digits: ' ||
                          regexp_replace(pg_get_constraintdef(oid), '[^0-9]', '', 'g') || ']'
                     from pg_constraint
                    where conrelid = (select oid from tbl)
                      and conname = 'statement_drafts_essay_length'), '(none)'),
         'CHECK ((char_)?length(essay) <= 20000)   [digits: 20000]',
         case when exists (select 1 from pg_constraint
                            where conrelid = (select oid from tbl)
                              and conname = 'statement_drafts_essay_length'
                              and pg_get_constraintdef(oid) ~ '(char_)?length\(essay\)'
                              -- 20000 EXACTLY. A bare `~ '<= 20000'` also matches
                              -- '<= 200000', so the bound is asserted by digit
                              -- signature instead: see the title check below.
                              and regexp_replace(pg_get_constraintdef(oid), '[^0-9]', '', 'g') = '20000')
              then 'PASS' else 'FAIL' end

  union all
  select 502, 'check statement_drafts_title_length',
         coalesce((select pg_get_constraintdef(oid) || '   [digits: ' ||
                          regexp_replace(pg_get_constraintdef(oid), '[^0-9]', '', 'g') || ']'
                     from pg_constraint
                    where conrelid = (select oid from tbl)
                      and conname = 'statement_drafts_title_length'), '(none)'),
         'btrim(title), lower bound 1, upper bound EXACTLY 200   [digits: 1200]',
         -- THE BOUNDS ARE ASSERTED BY DIGIT SIGNATURE, not by substring.
         --
         -- `between 1 and 200` renders as
         --   CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 200)))
         -- whose digits, in order, are 1 then 200 -> '1200'. Stripping every
         -- non-digit and comparing the whole string is exact, and it is immune to
         -- how Postgres nests parentheses or spaces the operators.
         --
         -- A substring test on '200' passed for 2000 and 20000. This does not:
         --   <= 20     -> '120'     <= 199  -> '1199'    <= 201 -> '1201'
         --   <= 2000   -> '12000'   <= 20000 -> '120000'  >= 10 -> '10200'
         -- none of which equals '1200'. The column name carries no digits, so the
         -- signature can only come from the two bounds.
         case when exists (select 1 from pg_constraint
                            where conrelid = (select oid from tbl)
                              and conname = 'statement_drafts_title_length'
                              -- structure: the bound is on the TRIMMED title
                              and pg_get_constraintdef(oid) ~ '(char_)?length\(btrim\(title\)\)'
                              -- and it is >= 1 and <= 200, exactly, in that order
                              and pg_get_constraintdef(oid) ~ '>= 1'
                              and pg_get_constraintdef(oid) ~ '<= 200'
                              and regexp_replace(pg_get_constraintdef(oid), '[^0-9]', '', 'g') = '1200')
              then 'PASS' else 'FAIL' end

  -- ---- 7. the listing index ----------------------------------------
  union all
  select 600, 'index statement_drafts_user_updated_idx',
         coalesce((select indexdef from pg_indexes
                    where schemaname = 'public'
                      and indexname = 'statement_drafts_user_updated_idx'), '(none)'),
         'btree (user_id, updated_at DESC)',
         case when exists (select 1 from pg_indexes
                            where schemaname = 'public'
                              and indexname = 'statement_drafts_user_updated_idx'
                              and indexdef ~ 'user_id, updated_at DESC')
              then 'PASS' else 'FAIL' end

  -- ---- 8. RLS ------------------------------------------------------
  union all
  select 700, 'row level security enabled',
         coalesce((select case when c.relrowsecurity then 'enabled' else 'DISABLED' end
                     from pg_class c where c.oid = (select oid from tbl)), '(no table)'),
         'enabled',
         case when exists (select 1 from pg_class c
                            where c.oid = (select oid from tbl) and c.relrowsecurity)
              then 'PASS' else 'FAIL -- table is readable by any authenticated user' end

  -- ---- 9. the four policies, one row each --------------------------
  union all
  select 800 + e.ord,
         'policy ' || e.pname,
         coalesce(p.cmd || ' to ' || p.roles::text || ' using=' ||
                  coalesce(p.qual, '(none)') || ' check=' ||
                  coalesce(p.with_check, '(none)'), '(missing)'),
         e.cmd || ' to {authenticated}, own rows only',
         case
           when p.policyname is null then 'FAIL -- missing'
           when p.cmd <> e.cmd then 'FAIL -- wrong command'
           when p.roles::text <> '{authenticated}' then 'FAIL -- wrong roles'
           when e.cmd = 'INSERT'
                then case when coalesce(p.with_check, '') ~ 'auth\.uid\(\)'
                          then 'PASS' else 'FAIL -- with check' end
           when e.cmd = 'UPDATE'
                then case when coalesce(p.qual, '') ~ 'auth\.uid\(\)'
                           and coalesce(p.with_check, '') ~ 'auth\.uid\(\)'
                          then 'PASS'
                          else 'FAIL -- UPDATE needs BOTH using and with check' end
           when coalesce(p.qual, '') ~ 'auth\.uid\(\)' then 'PASS'
           else 'FAIL -- using'
         end
  from expected_policies e
  left join pg_policies p
    on p.schemaname = 'public' and p.tablename = 'statement_drafts'
   and p.policyname = e.pname

  -- ---- 10. no policies beyond the four -----------------------------
  union all
  select 900, 'no unexpected policies',
         coalesce((select string_agg(policyname, ', ' order by policyname) from pg_policies
                    where schemaname = 'public' and tablename = 'statement_drafts'
                      and policyname not in ('own statement draft select',
                                             'own statement draft insert',
                                             'own statement draft update',
                                             'own statement draft delete')), 'none'),
         'none -- exactly four',
         case when exists (select 1 from pg_policies
                            where schemaname = 'public' and tablename = 'statement_drafts'
                              and policyname not in ('own statement draft select',
                                                     'own statement draft insert',
                                                     'own statement draft update',
                                                     'own statement draft delete'))
              then 'FAIL' else 'PASS' end

  -- ---- 11. grants: authenticated only ------------------------------
  union all
  select 1000, 'grants: authenticated',
         case when (select oid from tbl) is null then '(no table)' else
           concat_ws(',',
             case when has_table_privilege('authenticated',(select oid::oid from tbl),'SELECT') then 'SELECT' end,
             case when has_table_privilege('authenticated',(select oid::oid from tbl),'INSERT') then 'INSERT' end,
             case when has_table_privilege('authenticated',(select oid::oid from tbl),'UPDATE') then 'UPDATE' end,
             case when has_table_privilege('authenticated',(select oid::oid from tbl),'DELETE') then 'DELETE' end,
             case when has_table_privilege('authenticated',(select oid::oid from tbl),'TRUNCATE') then 'TRUNCATE!' end,
             case when has_table_privilege('authenticated',(select oid::oid from tbl),'REFERENCES') then 'REFERENCES!' end,
             case when has_table_privilege('authenticated',(select oid::oid from tbl),'TRIGGER') then 'TRIGGER!' end)
         end,
         'SELECT,INSERT,UPDATE,DELETE and nothing else',
         case when (select oid from tbl) is null then 'FAIL'
              when has_table_privilege('authenticated',(select oid::oid from tbl),'SELECT')
               and has_table_privilege('authenticated',(select oid::oid from tbl),'INSERT')
               and has_table_privilege('authenticated',(select oid::oid from tbl),'UPDATE')
               and has_table_privilege('authenticated',(select oid::oid from tbl),'DELETE')
               and not has_table_privilege('authenticated',(select oid::oid from tbl),'TRUNCATE')
               and not has_table_privilege('authenticated',(select oid::oid from tbl),'REFERENCES')
               and not has_table_privilege('authenticated',(select oid::oid from tbl),'TRIGGER')
              then 'PASS' else 'FAIL' end

  union all
  select 1001, 'grants: anon (must be none)',
         case when (select oid from tbl) is null then '(no table)' else
           coalesce(nullif(concat_ws(',',
             case when has_table_privilege('anon',(select oid::oid from tbl),'SELECT') then 'SELECT' end,
             case when has_table_privilege('anon',(select oid::oid from tbl),'INSERT') then 'INSERT' end,
             case when has_table_privilege('anon',(select oid::oid from tbl),'UPDATE') then 'UPDATE' end,
             case when has_table_privilege('anon',(select oid::oid from tbl),'DELETE') then 'DELETE' end), ''), 'none')
         end,
         'none',
         case when (select oid from tbl) is null then 'FAIL'
              when has_table_privilege('anon',(select oid::oid from tbl),'SELECT')
                or has_table_privilege('anon',(select oid::oid from tbl),'INSERT')
                or has_table_privilege('anon',(select oid::oid from tbl),'UPDATE')
                or has_table_privilege('anon',(select oid::oid from tbl),'DELETE')
              then 'FAIL -- anon can reach applicant essays' else 'PASS' end

  union all
  select 1002, 'grants: service_role (must be none)',
         case when (select oid from tbl) is null then '(no table)' else
           coalesce(nullif(concat_ws(',',
             case when has_table_privilege('service_role',(select oid::oid from tbl),'SELECT') then 'SELECT' end,
             case when has_table_privilege('service_role',(select oid::oid from tbl),'INSERT') then 'INSERT' end,
             case when has_table_privilege('service_role',(select oid::oid from tbl),'UPDATE') then 'UPDATE' end,
             case when has_table_privilege('service_role',(select oid::oid from tbl),'DELETE') then 'DELETE' end), ''), 'none')
         end,
         'none -- draft CRUD never uses the service role',
         case when (select oid from tbl) is null then 'FAIL'
              when has_table_privilege('service_role',(select oid::oid from tbl),'SELECT')
                or has_table_privilege('service_role',(select oid::oid from tbl),'INSERT')
                or has_table_privilege('service_role',(select oid::oid from tbl),'UPDATE')
                or has_table_privilege('service_role',(select oid::oid from tbl),'DELETE')
              then 'FAIL' else 'PASS' end

  -- ---- 12. PUBLIC exposure. grantee 0 in the ACL IS PUBLIC, and a
  --          privilege held by PUBLIC is held by every role including anon.
  union all
  select 1003, 'PUBLIC grants (must be none)',
         coalesce((select string_agg(a.privilege_type, ',' order by a.privilege_type)
                     from pg_class c, aclexplode(c.relacl) a
                    where c.oid = (select oid from tbl) and a.grantee = 0), 'none'),
         'none',
         case when exists (select 1 from pg_class c, aclexplode(c.relacl) a
                            where c.oid = (select oid from tbl) and a.grantee = 0)
              then 'FAIL -- PUBLIC holds a privilege' else 'PASS' end

  union all
  select 1004, 'full ACL, for the record',
         coalesce((select c.relacl::text from pg_class c where c.oid = (select oid from tbl)),
                  '(null -- owner-only defaults)'),
         'authenticated=arwd only, besides the owner',
         'INFO'

  -- ---- 13. NO USER-DEFINED TRIGGER. This is an assertion, not a note.
  --
  -- The approved architecture is that the save route sets updated_at itself, on
  -- a successful persisted save and at no other time, because updated_at is the
  -- 400-day inactivity clock. A BEFORE UPDATE touch trigger would advance that
  -- clock on writes the policy does not count as activity, so its absence is a
  -- requirement of the design rather than an incidental fact.
  --
  -- tgisinternal excludes system-generated triggers; tgconstraint = 0 excludes
  -- the RI triggers the foreign key to auth.users creates on this table, which
  -- are legitimate and must not be reported as a deviation.
  union all
  select 1100, 'no user-defined trigger (the save route owns updated_at)',
         coalesce((select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t
                    where t.tgrelid = (select oid from tbl)
                      and not t.tgisinternal and t.tgconstraint = 0), 'none'),
         'none -- no trigger may modify updated_at',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when exists (select 1 from pg_trigger t
                            where t.tgrelid = (select oid from tbl)
                              and not t.tgisinternal and t.tgconstraint = 0)
              then 'FAIL -- an automatic trigger would corrupt the retention clock'
              else 'PASS' end
)
select step, check_name, actual, expected, verdict
from checks
order by step;

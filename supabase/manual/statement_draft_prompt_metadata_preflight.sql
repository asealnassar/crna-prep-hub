-- Statement draft prompt metadata -- PREFLIGHT. READ-ONLY. Run BEFORE the migration.
--
-- Migration: supabase/migrations/20260930_001_statement_draft_prompt_metadata.sql
--
-- ONE STATEMENT, deliberately. The Supabase SQL editor displays only the LAST
-- result of a multi-statement script, so a preflight split into several SELECTs
-- shows one answer and hides the rest. Everything below is a single query.
--
-- READ THE VERDICT COLUMN. Any row reading FAIL means do not apply the
-- migration yet. Rows marked INFO are context the migration already accounts
-- for and are not pass/fail.
--
-- TWO INFO ROWS ARE MEANT TO BE WRITTEN DOWN: the row count and the latest
-- updated_at. The postcheck reports the same two values, and they must match --
-- that is how "this migration modified no row" is evidenced across two scripts
-- that run at different times.
--
-- Mutates nothing: every reference is a catalog read, plus two aggregates over
-- statement_drafts that return no row contents.

with
tbl as (select to_regclass('public.statement_drafts') as oid),

new_cols(ord, col, typ) as (
  values
    (1, 'school_id',        'uuid'),
    (2, 'prompt_id',        'uuid'),
    (3, 'prompt_text',      'text'),
    (4, 'stated_max_words', 'integer')
),

original_cols(ord, col, typ, nullable) as (
  values
    (1, 'id',         'uuid',                     'NO'),
    (2, 'user_id',    'uuid',                     'NO'),
    (3, 'title',      'text',                     'NO'),
    (4, 'essay',      'text',                     'NO'),
    (5, 'revision',   'bigint',                   'NO'),
    (6, 'created_at', 'timestamp with time zone', 'NO'),
    (7, 'updated_at', 'timestamp with time zone', 'NO')
),

checks as (
  -- 1. The table must exist. Everything below is about altering it.
  select 100 as step,
         'public.statement_drafts exists' as check_name,
         coalesce((select oid::text from tbl), 'MISSING') as actual,
         'present' as expected,
         case when (select oid from tbl) is null
              then 'FAIL -- STOP, apply 20260928_000_statement_drafts.sql first'
              else 'PASS' end as verdict

  -- 2. THE SHAPE THIS MIGRATION IS WRITTEN AGAINST. Exactly 7 columns. More
  -- than 7 means some of the new columns may already exist, or something else
  -- altered the table -- either way, read row 300 before proceeding.
  union all
  select 110, 'column count is exactly 7 (the pre-migration shape)',
         coalesce((select count(*)::text from pg_attribute a
                    where a.attrelid = (select oid from tbl)
                      and a.attnum > 0 and not a.attisdropped), 'n/a'),
         '7',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when (select count(*) from pg_attribute a
                     where a.attrelid = (select oid from tbl)
                       and a.attnum > 0 and not a.attisdropped) = 7
              then 'PASS'
              else 'FAIL -- unexpected shape; do not apply until row 300 is understood' end

  -- 3. The 7 originals must be exactly as the first migration left them. If one
  -- has drifted, this migration is being applied to a table it was not written
  -- against.
  union all
  select 120 + e.ord,
         'original column ' || e.col || ' is ' || e.typ || ' / ' || e.nullable,
         coalesce((select format_type(a.atttypid, a.atttypmod)
                          || ' / ' || case when a.attnotnull then 'NO' else 'YES' end
                     from pg_attribute a
                    where a.attrelid = (select oid from tbl) and a.attname = e.col
                      and a.attnum > 0 and not a.attisdropped), 'MISSING'),
         e.typ || ' / ' || e.nullable,
         case when coalesce((select format_type(a.atttypid, a.atttypmod)
                                    || ' / ' || case when a.attnotnull then 'NO' else 'YES' end
                               from pg_attribute a
                              where a.attrelid = (select oid from tbl) and a.attname = e.col
                                and a.attnum > 0 and not a.attisdropped), 'MISSING')
                   = e.typ || ' / ' || e.nullable
              then 'PASS' else 'FAIL -- the original column has drifted' end
  from original_cols e

  -- 4. NAME COLLISION. A column of one of these names must not already exist.
  -- `add column if not exists` would skip it silently, and a pre-existing
  -- column of the wrong type would then fail the CHECK or, worse, pass it.
  union all
  select 200 + e.ord,
         'no existing column named ' || e.col,
         coalesce((select format_type(a.atttypid, a.atttypmod)
                          || ' / ' || case when a.attnotnull then 'NOT NULL' else 'NULL' end
                     from pg_attribute a
                    where a.attrelid = (select oid from tbl) and a.attname = e.col
                      and a.attnum > 0 and not a.attisdropped), 'absent'),
         'absent',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when not exists (select 1 from pg_attribute a
                                where a.attrelid = (select oid from tbl) and a.attname = e.col
                                  and a.attnum > 0 and not a.attisdropped)
              then 'PASS'
              when (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
                     where a.attrelid = (select oid from tbl) and a.attname = e.col) = e.typ
              then 'FAIL -- already present with the right type; ADD COLUMN would silently skip'
              else 'FAIL -- already present with the WRONG type; resolve before applying' end
  from new_cols e

  -- 5. CONSTRAINT NAME COLLISION. drop-then-add means an existing constraint of
  -- either name would be silently replaced, which is fine if it is ours and not
  -- fine if it is not.
  union all
  select 300, 'no existing constraint of the names this file creates',
         coalesce((select string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), '; '
                                     order by c.conname)
                     from pg_constraint c
                    where c.conrelid = (select oid from tbl)
                      and c.conname in ('statement_drafts_prompt_text_length',
                                        'statement_drafts_stated_max_words_range')), 'none'),
         'none',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from tbl)
                              and c.conname in ('statement_drafts_prompt_text_length',
                                                'statement_drafts_stated_max_words_range'))
              then 'FAIL -- a constraint of that name exists; inspect it before applying'
              else 'PASS' end

  -- 6. btrim() and char_length() are core builtins; named so a reader can see
  -- the CHECK constraints have no extension dependency.
  union all
  select 310, 'btrim() and char_length() resolve (CHECK dependencies)',
         (select string_agg(distinct p.proname, ', ' order by p.proname)
            from pg_proc p where p.proname in ('btrim', 'char_length')),
         'btrim, char_length',
         case when (select count(distinct proname) from pg_proc
                     where proname in ('btrim', 'char_length')) = 2
              then 'PASS' else 'FAIL -- a CHECK constraint would not compile' end

  -- 7. THE EXISTING SECURITY SURFACE, recorded so the postcheck can be compared
  -- against it. This migration changes none of it.
  union all
  select 400, 'RLS enabled and 4 owner-only policies (recorded for comparison)',
         coalesce((select c.relrowsecurity::text from pg_class c
                    where c.oid = (select oid from tbl)), 'n/a')
           || ' / ' ||
         coalesce((select count(*)::text from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_drafts'), '0')
           || ' policies',
         'true / 4 policies',
         case when (select c.relrowsecurity from pg_class c where c.oid = (select oid from tbl))
               and (select count(*) from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'statement_drafts') = 4
              then 'PASS' else 'FAIL -- the security surface is not what this migration assumes' end

  union all
  select 410, 'exactly one FK (user_id -> auth.users), recorded for comparison',
         coalesce((select string_agg(pg_get_constraintdef(c.oid), '; ') from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'f'), 'none'),
         'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
         case when (select count(*) from pg_constraint c
                     where c.conrelid = (select oid from tbl) and c.contype = 'f') = 1
              then 'PASS' else 'FAIL -- unexpected foreign key set' end

  union all
  select 420, 'grants are TABLE-level for authenticated only (INFO -- why no grant line)',
         coalesce((select string_agg(distinct g.grantee || ':' || g.privilege_type, ', '
                                     order by g.grantee || ':' || g.privilege_type)
                     from information_schema.table_privileges g
                    where g.table_schema = 'public' and g.table_name = 'statement_drafts'), 'none'),
         'authenticated: SELECT/INSERT/UPDATE/DELETE, and nothing else',
         'INFO -- table-level grants extend to new columns automatically'

  -- 8. WRITE THESE TWO DOWN. The postcheck reports the same values; they must
  -- match, which is the evidence that no row was touched. Aggregates only -- no
  -- row contents are returned.
  union all
  select 500, 'draft row count BEFORE (INFO -- compare with the postcheck)',
         coalesce((select count(*)::text from public.statement_drafts), 'n/a'),
         'record this number',
         'INFO'

  union all
  select 510, 'latest updated_at BEFORE (INFO -- compare with the postcheck)',
         coalesce((select max(updated_at)::text from public.statement_drafts), 'no rows'),
         'record this timestamp',
         'INFO'

  -- 9. CONTEXT. Neither FK target matters to this migration, because it
  -- declares no foreign key. Both answers are acceptable.
  union all
  select 600, 'public.schools present (INFO -- not required, no FK declared)',
         case when to_regclass('public.schools') is null then 'absent' else 'present' end,
         'either is fine',
         'INFO'

  union all
  select 610, 'public.statement_prompts present (INFO -- not required, no FK declared)',
         case when to_regclass('public.statement_prompts') is null then 'absent' else 'present' end,
         'either is fine -- the FK checkpoint comes later',
         'INFO'
)
select step, check_name, actual, expected, verdict
from checks
order by step;

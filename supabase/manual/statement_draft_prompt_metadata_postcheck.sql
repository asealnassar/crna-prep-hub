-- Statement draft prompt metadata -- POST-MIGRATION VERIFICATION. READ-ONLY.
-- Run immediately after
-- supabase/migrations/20260930_001_statement_draft_prompt_metadata.sql.
--
-- ONE STATEMENT, deliberately: the Supabase SQL editor shows only the LAST
-- result of a multi-statement script, so every check below is unioned into a
-- single query and the whole matrix is visible at once.
--
-- PASS CONDITION: every row reads PASS, except the rows marked INFO, which are
-- context rather than assertions. A single FAIL means the migration did not land
-- as designed -- do not build on it.
--
-- TWO INFO ROWS MUST BE COMPARED BY HAND against the preflight's rows 500 and
-- 510: the draft row count and the latest updated_at. If either moved, this
-- migration modified rows, which it is designed not to do. The all-NULL check
-- at step 700 is the self-contained half of that proof; the comparison is the
-- other half.
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

-- All 11 columns after the migration: the 7 originals unchanged, then the 4 new
-- ones. Asserting the originals here is how "the original 7 remain unchanged"
-- is verified -- type, nullability and default, each one.
expected_cols(ord, col, typ, nullable, def_pattern, def_note) as (
  values
    (1,  'id',               'uuid',                     'NO',  'gen_random_uuid', 'gen_random_uuid()'),
    (2,  'user_id',          'uuid',                     'NO',  null::text,        '(none)'),
    (3,  'title',            'text',                     'NO',  null::text,        '(none)'),
    (4,  'essay',            'text',                     'NO',  '::text',          'empty string'),
    (5,  'revision',         'bigint',                   'NO',  '^1',              '1'),
    (6,  'created_at',       'timestamp with time zone', 'NO',  'now',             'now()'),
    (7,  'updated_at',       'timestamp with time zone', 'NO',  'now',             'now()'),
    (8,  'school_id',        'uuid',                     'YES', null::text,        '(none)'),
    (9,  'prompt_id',        'uuid',                     'YES', null::text,        '(none)'),
    (10, 'prompt_text',      'text',                     'YES', null::text,        '(none)'),
    (11, 'stated_max_words', 'integer',                  'YES', null::text,        '(none)')
),

new_cols(ord, col) as (
  values (1, 'school_id'), (2, 'prompt_id'), (3, 'prompt_text'), (4, 'stated_max_words')
),

expected_policies(ord, pname, cmd) as (
  values
    (1, 'own statement draft select', 'SELECT'),
    (2, 'own statement draft insert', 'INSERT'),
    (3, 'own statement draft update', 'UPDATE'),
    (4, 'own statement draft delete', 'DELETE')
),

checks as (
  -- ---------------------------------------------------------------- existence
  select 100 as step,
         'table public.statement_drafts exists' as check_name,
         coalesce((select oid::text from tbl), 'MISSING') as actual,
         'present' as expected,
         case when (select oid from tbl) is null
              then 'FAIL -- nothing else below is meaningful' else 'PASS' end as verdict

  -- ------------------------------------------------------------------ columns
  union all
  select 110, 'column count is exactly 11 (7 original + 4 new)',
         coalesce((select count(*)::text from pg_attribute a
                    where a.attrelid = (select oid from tbl)
                      and a.attnum > 0 and not a.attisdropped), 'n/a'),
         '11',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when (select count(*) from pg_attribute a
                     where a.attrelid = (select oid from tbl)
                       and a.attnum > 0 and not a.attisdropped) = 11
              then 'PASS' else 'FAIL -- unexpected column set' end

  union all
  select 120 + e.ord,
         case when e.ord <= 7 then 'ORIGINAL column ' else 'NEW column ' end
           || e.col || ' type/nullability/default',
         coalesce((select format_type(a.atttypid, a.atttypmod)
                          || ' / ' || case when a.attnotnull then 'NO' else 'YES' end
                          || ' / ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '(none)')
                     from pg_attribute a
                     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                    where a.attrelid = (select oid from tbl) and a.attname = e.col
                      and a.attnum > 0 and not a.attisdropped), 'MISSING'),
         e.typ || ' / ' || e.nullable || ' / ' || e.def_note,
         case
           when (select oid from tbl) is null then 'FAIL -- no table'
           when not exists (select 1 from pg_attribute a
                             where a.attrelid = (select oid from tbl) and a.attname = e.col
                               and a.attnum > 0 and not a.attisdropped)
             then 'FAIL -- column missing'
           when (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
                  where a.attrelid = (select oid from tbl) and a.attname = e.col) <> e.typ
             then 'FAIL -- wrong type'
           when (select case when a.attnotnull then 'NO' else 'YES' end from pg_attribute a
                  where a.attrelid = (select oid from tbl) and a.attname = e.col) <> e.nullable
             then 'FAIL -- wrong nullability'
           when e.def_pattern is null
                and (select pg_get_expr(d.adbin, d.adrelid) from pg_attribute a
                      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                     where a.attrelid = (select oid from tbl) and a.attname = e.col) is not null
             then 'FAIL -- unexpected default'
           when e.def_pattern is not null
                and coalesce((select pg_get_expr(d.adbin, d.adrelid) from pg_attribute a
                               left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                              where a.attrelid = (select oid from tbl) and a.attname = e.col), '')
                    !~ e.def_pattern
             then 'FAIL -- wrong default'
           else 'PASS'
         end
  from expected_cols e

  -- ALL FOUR NEW COLUMNS ARE NULLABLE, called out on one line because it is the
  -- property that makes every existing draft still valid.
  union all
  select 150, 'all four new columns are NULLABLE with no default',
         coalesce((select string_agg(a.attname || '=' ||
                        case when a.attnotnull then 'NOT NULL' else 'NULL' end ||
                        case when d.adbin is null then '' else '+DEFAULT' end, ', '
                        order by a.attname)
                     from pg_attribute a
                     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                    where a.attrelid = (select oid from tbl)
                      and a.attname in ('school_id','prompt_id','prompt_text','stated_max_words')),
                  'MISSING'),
         'all NULL, none with a DEFAULT',
         case when exists (select 1 from pg_attribute a
                            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                           where a.attrelid = (select oid from tbl)
                             and a.attname in ('school_id','prompt_id','prompt_text','stated_max_words')
                             and (a.attnotnull or d.adbin is not null))
              then 'FAIL -- a NOT NULL or defaulted column would invalidate existing drafts'
              else 'PASS' end

  -- ------------------------------------------------------- the two CHECKs
  union all
  select 200, 'CHECK statement_drafts_prompt_text_length present',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl)
                      and c.conname = 'statement_drafts_prompt_text_length'), 'MISSING'),
         'prompt_text IS NULL OR (btrim >= 1 AND char_length <= 5000)',
         case when not exists (select 1 from pg_constraint c
                                where c.conrelid = (select oid from tbl)
                                  and c.conname = 'statement_drafts_prompt_text_length')
                then 'FAIL -- constraint missing'
              when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_drafts_prompt_text_length')
                   not ilike '%is null%'
                then 'FAIL -- expected the canonical IS NULL OR form, as in statement_prompts (NULL already passes; only FALSE rejects)'
              when (select regexp_replace(pg_get_constraintdef(c.oid), '[^0-9]', '', 'g')
                      from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_drafts_prompt_text_length') <> '15000'
                then 'FAIL -- expected the digits 1 then 5000'
              else 'PASS' end

  union all
  select 210, 'CHECK statement_drafts_stated_max_words_range present',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl)
                      and c.conname = 'statement_drafts_stated_max_words_range'), 'MISSING'),
         'stated_max_words IS NULL OR BETWEEN 1 AND 5000',
         case when not exists (select 1 from pg_constraint c
                                where c.conrelid = (select oid from tbl)
                                  and c.conname = 'statement_drafts_stated_max_words_range')
                then 'FAIL -- constraint missing'
              when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_drafts_stated_max_words_range')
                   not ilike '%is null%'
                then 'FAIL -- expected the canonical IS NULL OR form, as in statement_prompts (NULL already passes; only FALSE rejects)'
              when (select regexp_replace(pg_get_constraintdef(c.oid), '[^0-9]', '', 'g')
                      from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_drafts_stated_max_words_range') <> '15000'
                then 'FAIL -- expected the digits 1 then 5000'
              else 'PASS' end

  -- The originals' own CHECKs must survive untouched.
  union all
  select 220, 'the ORIGINAL three CHECK constraints are still present',
         coalesce((select string_agg(c.conname, ', ' order by c.conname) from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'c'
                      and c.conname in ('statement_drafts_revision_positive',
                                        'statement_drafts_essay_length',
                                        'statement_drafts_title_length')), 'none'),
         'revision_positive, essay_length, title_length',
         case when (select count(*) from pg_constraint c
                     where c.conrelid = (select oid from tbl) and c.contype = 'c'
                       and c.conname in ('statement_drafts_revision_positive',
                                         'statement_drafts_essay_length',
                                         'statement_drafts_title_length')) = 3
              then 'PASS' else 'FAIL -- an original constraint was lost' end

  union all
  select 230, 'CHECK constraint count is exactly 5 (3 original + 2 new)',
         coalesce((select count(*)::text from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'c'), 'n/a'),
         '5',
         case when (select count(*) from pg_constraint c
                     where c.conrelid = (select oid from tbl) and c.contype = 'c') = 5
              then 'PASS' else 'FAIL -- unexpected CHECK set' end

  -- ---------------------------------------- PK / FK / uniqueness / indexes
  union all
  select 300, 'primary key still (id)',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'p'), 'MISSING'),
         'PRIMARY KEY (id)',
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from tbl) and c.contype = 'p')
                   = 'PRIMARY KEY (id)'
              then 'PASS' else 'FAIL' end

  union all
  select 310, 'still exactly ONE foreign key, and it is the original user_id one',
         coalesce((select string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), '; '
                                     order by c.conname)
                     from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'f'), 'none'),
         'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
         case when (select count(*) from pg_constraint c
                     where c.conrelid = (select oid from tbl) and c.contype = 'f') <> 1
                then 'FAIL -- the foreign key set changed'
              when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from tbl) and c.contype = 'f')
                   not ilike '%user_id%auth.users%on delete cascade%'
                then 'FAIL -- the surviving FK is not the original'
              else 'PASS' end

  -- THE HEADLINE ABSENCE: no FK on any of the four new columns.
  union all
  select 320, 'NO foreign key references any of the four new columns',
         coalesce((select string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), '; ')
                     from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'f'
                      and exists (select 1 from pg_attribute a
                                   where a.attrelid = (select oid from tbl)
                                     and a.attnum = any(c.conkey)
                                     and a.attname in ('school_id','prompt_id',
                                                       'prompt_text','stated_max_words'))),
                  'none'),
         'none -- schools has no migration, and prompt_id waits for the FK checkpoint',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from tbl) and c.contype = 'f'
                              and exists (select 1 from pg_attribute a
                                           where a.attrelid = (select oid from tbl)
                                             and a.attnum = any(c.conkey)
                                             and a.attname in ('school_id','prompt_id',
                                                               'prompt_text','stated_max_words')))
              then 'FAIL -- an FK was added on a new column' else 'PASS' end

  union all
  select 330, 'NO uniqueness constraint of any kind',
         coalesce((select string_agg(c.conname || ' (' || c.contype::text || ')', ', '
                                     order by c.conname)
                     from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype in ('u', 'x')), 'none'),
         'none -- multiple drafts per prompt is the approved model',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from tbl) and c.contype in ('u', 'x'))
              then 'FAIL -- a uniqueness constraint was added' else 'PASS' end

  union all
  select 340, 'no unique INDEX either, besides the primary key''s own',
         coalesce((select string_agg(i.indexname, ', ' order by i.indexname) from pg_indexes i
                    where i.schemaname = 'public' and i.tablename = 'statement_drafts'
                      and i.indexdef ilike '%unique index%'
                      and i.indexname <> 'statement_drafts_pkey'), 'none'),
         'none',
         case when exists (select 1 from pg_indexes i
                            where i.schemaname = 'public' and i.tablename = 'statement_drafts'
                              and i.indexdef ilike '%unique index%'
                              and i.indexname <> 'statement_drafts_pkey')
              then 'FAIL' else 'PASS' end

  union all
  select 350, 'index set unchanged: the PK plus the original (user_id, updated_at desc)',
         coalesce((select string_agg(i.indexname, ', ' order by i.indexname) from pg_indexes i
                    where i.schemaname = 'public' and i.tablename = 'statement_drafts'), 'none'),
         'statement_drafts_pkey, statement_drafts_user_updated_idx',
         case when (select count(*) from pg_indexes i
                     where i.schemaname = 'public' and i.tablename = 'statement_drafts') = 2
               and exists (select 1 from pg_indexes i
                            where i.schemaname = 'public'
                              and i.indexname = 'statement_drafts_user_updated_idx')
              then 'PASS' else 'FAIL -- the index set changed' end

  -- --------------------------------------------------------- RLS unchanged
  union all
  select 400, 'row level security still ENABLED',
         coalesce((select case when c.relrowsecurity then 'enabled' else 'DISABLED' end
                     from pg_class c where c.oid = (select oid from tbl)), 'n/a'),
         'enabled',
         case when (select c.relrowsecurity from pg_class c where c.oid = (select oid from tbl))
              then 'PASS' else 'FAIL' end

  union all
  select 410, 'still exactly 4 policies, and no more',
         coalesce((select count(*)::text from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_drafts'), '0'),
         '4',
         case when (select count(*) from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'statement_drafts') = 4
              then 'PASS' else 'FAIL -- the policy set changed' end

  union all
  select 420 + e.ord,
         'policy "' || e.pname || '" still ' || e.cmd || ' and still owner-only',
         coalesce((select p.cmd || ' / USING ' || coalesce(p.qual, '-')
                          || ' / CHECK ' || coalesce(p.with_check, '-')
                     from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_drafts'
                      and p.policyname = e.pname), 'MISSING'),
         e.cmd || ', keyed on auth.uid()',
         case when not exists (select 1 from pg_policies p
                                where p.schemaname = 'public' and p.tablename = 'statement_drafts'
                                  and p.policyname = e.pname)
                then 'FAIL -- policy missing'
              when (select p.cmd from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'statement_drafts'
                       and p.policyname = e.pname) <> e.cmd
                then 'FAIL -- policy command changed'
              when coalesce((select coalesce(p.qual, '') || coalesce(p.with_check, '')
                               from pg_policies p
                              where p.schemaname = 'public' and p.tablename = 'statement_drafts'
                                and p.policyname = e.pname), '') not ilike '%uid%'
                then 'FAIL -- policy no longer keys on auth.uid()'
              else 'PASS' end
  from expected_policies e

  union all
  select 430, 'no policy mentions any of the four new columns',
         coalesce((select string_agg(p.policyname, ', ') from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_drafts'
                      and (coalesce(p.qual, '') || coalesce(p.with_check, ''))
                          ~ '(school_id|prompt_id|prompt_text|stated_max_words)'), 'none'),
         'none -- row access is decided by user_id alone',
         case when exists (select 1 from pg_policies p
                            where p.schemaname = 'public' and p.tablename = 'statement_drafts'
                              and (coalesce(p.qual, '') || coalesce(p.with_check, ''))
                                  ~ '(school_id|prompt_id|prompt_text|stated_max_words)')
              then 'FAIL -- a policy was rewritten' else 'PASS' end

  -- ------------------------------------------------------ GRANTS unchanged
  union all
  select 500, 'authenticated still holds SELECT/INSERT/UPDATE/DELETE',
         coalesce((select string_agg(pr || '=' ||
                     has_table_privilege('authenticated', (select oid from tbl), pr)::text, ', ')
                     from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr)), 'n/a'),
         'all true',
         case when (select bool_and(has_table_privilege('authenticated', (select oid from tbl), pr))
                      from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr))
              then 'PASS' else 'FAIL -- the grant was narrowed' end

  union all
  select 510, 'anon still holds nothing',
         coalesce((select string_agg(pr || '=' ||
                     has_table_privilege('anon', (select oid from tbl), pr)::text, ', ')
                     from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr)), 'n/a'),
         'all false',
         case when (select bool_or(has_table_privilege('anon', (select oid from tbl), pr))
                      from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr))
              then 'FAIL -- anon gained a privilege' else 'PASS' end

  union all
  select 520, 'service_role still holds nothing',
         coalesce((select string_agg(pr || '=' ||
                     has_table_privilege('service_role', (select oid from tbl), pr)::text, ', ')
                     from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr)), 'n/a'),
         'all false',
         case when (select bool_or(has_table_privilege('service_role', (select oid from tbl), pr))
                      from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr))
              then 'FAIL -- service_role gained a privilege' else 'PASS' end

  -- PUBLIC is a pseudo-grantee: there is no pg_roles row named PUBLIC, so
  -- has_table_privilege('public', ...) resolves to nothing and errors. The grant
  -- is still visible as a row whose grantee is the literal 'PUBLIC'.
  union all
  select 530, 'PUBLIC still holds nothing (a PUBLIC privilege is held by every role)',
         coalesce((select string_agg(distinct g.privilege_type, ', ' order by g.privilege_type)
                     from information_schema.table_privileges g
                    where g.table_schema = 'public' and g.table_name = 'statement_drafts'
                      and g.grantee = 'PUBLIC'), 'none'),
         'none',
         case when exists (select 1 from information_schema.table_privileges g
                            where g.table_schema = 'public' and g.table_name = 'statement_drafts'
                              and g.grantee = 'PUBLIC')
              then 'FAIL -- PUBLIC grants reach anon' else 'PASS' end

  union all
  select 540, 'no COLUMN-level grant was introduced',
         coalesce((select string_agg(distinct g.grantee || ':' || g.column_name, ', ')
                     from information_schema.column_privileges g
                    where g.table_schema = 'public' and g.table_name = 'statement_drafts'
                      and g.grantee in ('anon', 'service_role')), 'none'),
         'none -- the grant is table-level and stays that way',
         case when exists (select 1 from information_schema.column_privileges g
                            where g.table_schema = 'public' and g.table_name = 'statement_drafts'
                              and g.grantee in ('anon', 'service_role'))
              then 'FAIL -- a column-level grant appeared' else 'PASS' end

  -- --------------------------------------- no trigger, no backfill, no writes
  union all
  select 600, 'no user-defined trigger (the save route still owns updated_at)',
         coalesce((select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t
                    where t.tgrelid = (select oid from tbl)
                      and not t.tgisinternal and t.tgconstraint = 0), 'none'),
         'none',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when exists (select 1 from pg_trigger t
                            where t.tgrelid = (select oid from tbl)
                              and not t.tgisinternal and t.tgconstraint = 0)
              then 'FAIL -- a trigger would change revision or updated_at behaviour'
              else 'PASS' end

  -- THE SELF-CONTAINED HALF OF THE NO-BACKFILL PROOF. An ADD COLUMN of a
  -- nullable, undefaulted column visits no row, so every pre-existing draft
  -- must read NULL in all four. A non-NULL value anywhere means something wrote.
  union all
  select 700, 'EVERY existing draft has all four new columns NULL (no backfill)',
         coalesce((select count(*)::text from public.statement_drafts
                    where school_id is not null or prompt_id is not null
                       or prompt_text is not null or stated_max_words is not null), 'n/a'),
         '0 rows carry any prompt metadata',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when (select count(*) from public.statement_drafts
                     where school_id is not null or prompt_id is not null
                        or prompt_text is not null or stated_max_words is not null) = 0
              then 'PASS'
              else 'FAIL -- rows were backfilled; this migration writes nothing' end

  union all
  select 710, 'draft row count AFTER (INFO -- must equal the preflight''s row 500)',
         coalesce((select count(*)::text from public.statement_drafts), 'n/a'),
         'the same number the preflight recorded',
         'INFO -- compare by hand'

  union all
  select 720, 'latest updated_at AFTER (INFO -- must equal the preflight''s row 510)',
         coalesce((select max(updated_at)::text from public.statement_drafts), 'no rows'),
         'the same timestamp the preflight recorded',
         'INFO -- compare by hand; a later value means a row was written'

  -- ------------------------------------------------------ untouched neighbours
  union all
  select 800, 'public.statement_prompts still has exactly 10 columns (untouched)',
         coalesce((select count(*)::text from pg_attribute a
                    where a.attrelid = to_regclass('public.statement_prompts')
                      and a.attnum > 0 and not a.attisdropped), 'absent'),
         '10',
         case when to_regclass('public.statement_prompts') is null
                then 'INFO -- prompt catalog absent in this environment'
              when (select count(*) from pg_attribute a
                     where a.attrelid = to_regclass('public.statement_prompts')
                       and a.attnum > 0 and not a.attisdropped) = 10
                then 'PASS' else 'FAIL -- the prompt catalog was modified' end

  union all
  select 810, 'public.statement_prompts is still empty (INFO -- nothing seeded here)',
         coalesce((select count(*)::text from public.statement_prompts), 'absent'),
         'whatever it was -- this migration seeds nothing',
         'INFO'
)
select step, check_name, actual, expected, verdict
from checks
order by step;

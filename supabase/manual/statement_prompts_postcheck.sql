-- Statement Prompts (prompt catalog) -- POST-MIGRATION VERIFICATION. READ-ONLY.
-- Run immediately after supabase/migrations/20260930_000_statement_prompts.sql.
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
tbl as (select to_regclass('public.statement_prompts') as oid),

expected_cols(ord, col, typ, nullable, def_pattern, def_note) as (
  values
    (1,  'id',                'uuid',                     'NO',  'gen_random_uuid', 'gen_random_uuid()'),
    (2,  'school_id',         'uuid',                     'NO',  null::text,        '(none)'),
    (3,  'label',             'text',                     'NO',  null::text,        '(none)'),
    (4,  'prompt_text',       'text',                     'NO',  null::text,        '(none)'),
    (5,  'stated_max_words',  'integer',                  'YES', null::text,        '(none)'),
    (6,  'application_cycle', 'text',                     'YES', null::text,        '(none)'),
    (7,  'is_active',         'boolean',                  'NO',  '^true',           'true'),
    (8,  'display_order',     'integer',                  'NO',  '^0',              '0'),
    (9,  'created_at',        'timestamp with time zone', 'NO',  'now',             'now()'),
    (10, 'updated_at',        'timestamp with time zone', 'NO',  'now',             'now()')
),

expected_checks(ord, cname, must_mention) as (
  values
    (1, 'statement_prompts_label_length',         'btrim'),
    (2, 'statement_prompts_text_length',          'btrim'),
    (3, 'statement_prompts_max_words_range',      'stated_max_words'),
    (4, 'statement_prompts_cycle_format',         'application_cycle'),
    (5, 'statement_prompts_display_order_nonneg', 'display_order')
),

checks as (
  -- ---------------------------------------------------------------- existence
  select 100 as step,
         'table public.statement_prompts exists' as check_name,
         coalesce((select oid::text from tbl), 'MISSING') as actual,
         'present' as expected,
         case when (select oid from tbl) is null then 'FAIL -- nothing else below is meaningful'
              else 'PASS' end as verdict

  -- ------------------------------------------------------------------ columns
  union all
  select 200, 'column count is exactly 10',
         coalesce((select count(*)::text from pg_attribute a
                    where a.attrelid = (select oid from tbl)
                      and a.attnum > 0 and not a.attisdropped), 'n/a'),
         '10',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when (select count(*) from pg_attribute a
                     where a.attrelid = (select oid from tbl)
                       and a.attnum > 0 and not a.attisdropped) = 10
              then 'PASS' else 'FAIL -- unexpected column set' end

  union all
  select 210 + e.ord,
         'column ' || e.col || ' type/nullability/default',
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

  -- THE HEADLINE TYPE ASSERTION, called out on its own line because the whole
  -- checkpoint was blocked on establishing it.
  union all
  select 250, 'school_id is uuid (matches schools.id)',
         coalesce((select format_type(a.atttypid, a.atttypmod) from pg_attribute a
                    where a.attrelid = (select oid from tbl) and a.attname = 'school_id'), 'MISSING'),
         'uuid',
         case when (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
                     where a.attrelid = (select oid from tbl) and a.attname = 'school_id') = 'uuid'
              then 'PASS' else 'FAIL' end

  -- -------------------------------------------------------------- primary key
  union all
  select 300, 'primary key is (id)',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'p'), 'MISSING'),
         'PRIMARY KEY (id)',
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from tbl) and c.contype = 'p')
                   = 'PRIMARY KEY (id)'
              then 'PASS' else 'FAIL' end

  -- --------------------------------------------------- CHECK constraints
  union all
  select 310 + e.ord,
         'CHECK ' || e.cname || ' present and references ' || e.must_mention,
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.conname = e.cname), 'MISSING'),
         'present, mentioning ' || e.must_mention,
         case
           when not exists (select 1 from pg_constraint c
                             where c.conrelid = (select oid from tbl) and c.conname = e.cname)
             then 'FAIL -- constraint missing'
           when position(e.must_mention in
                (select pg_get_constraintdef(c.oid) from pg_constraint c
                  where c.conrelid = (select oid from tbl) and c.conname = e.cname)) = 0
             then 'FAIL -- constraint does not reference ' || e.must_mention
           else 'PASS'
         end
  from expected_checks e

  -- The three bounds a reader most wants to see literally, rather than trusting
  -- that a constraint named "length" contains the right numbers.
  union all
  select 320, 'label bound is 1..200 and is measured TRIMMED',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl)
                      and c.conname = 'statement_prompts_label_length'), 'MISSING'),
         'btrim(label), 1 and 200',
         case when (select regexp_replace(pg_get_constraintdef(c.oid), '[^0-9]', '', 'g')
                      from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_prompts_label_length') = '1200'
              then 'PASS' else 'FAIL -- the numbers are not 1 and 200' end

  union all
  select 321, 'prompt_text ceiling is 5000 and rejects blank wording',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl)
                      and c.conname = 'statement_prompts_text_length'), 'MISSING'),
         'btrim >= 1 AND char_length <= 5000',
         case when (select regexp_replace(pg_get_constraintdef(c.oid), '[^0-9]', '', 'g')
                      from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_prompts_text_length') = '15000'
              then 'PASS' else 'FAIL -- expected the digits 1 then 5000' end

  union all
  select 322, 'stated_max_words is NULL-or-1..5000 (NULL branch explicit)',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl)
                      and c.conname = 'statement_prompts_max_words_range'), 'MISSING'),
         'IS NULL OR BETWEEN 1 AND 5000',
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_prompts_max_words_range') ilike '%is null%'
              then 'PASS'
              else 'FAIL -- without an explicit NULL branch the CHECK evaluates NULL and PASSES' end

  union all
  select 323, 'application_cycle accepts only YYYY or YYYY-YYYY, anchored',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from tbl)
                      and c.conname = 'statement_prompts_cycle_format'), 'MISSING'),
         'anchored ^...$ regex with two 4-digit groups',
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from tbl)
                       and c.conname = 'statement_prompts_cycle_format')
                   like '%^[0-9]{4}(-[0-9]{4})?$%'
              then 'PASS' else 'FAIL -- the pattern is not the approved anchored form' end

  -- ------------------------------------------------------------------- index
  union all
  select 400, 'index statement_prompts_school_active_order_idx on (school_id, is_active, display_order)',
         coalesce((select i.indexdef from pg_indexes i
                    where i.schemaname = 'public'
                      and i.indexname = 'statement_prompts_school_active_order_idx'), 'MISSING'),
         '(school_id, is_active, display_order)',
         case when (select i.indexdef from pg_indexes i
                     where i.schemaname = 'public'
                       and i.indexname = 'statement_prompts_school_active_order_idx')
                   like '%(school_id, is_active, display_order)%'
              then 'PASS' else 'FAIL' end

  union all
  select 410, 'no speculative extra indexes (PK + the picker index only)',
         coalesce((select string_agg(i.indexname, ', ' order by i.indexname)
                     from pg_indexes i where i.schemaname = 'public'
                       and i.tablename = 'statement_prompts'), 'none'),
         'statement_prompts_pkey, statement_prompts_school_active_order_idx',
         case when (select count(*) from pg_indexes i
                     where i.schemaname = 'public' and i.tablename = 'statement_prompts') = 2
              then 'PASS' else 'FAIL -- unexpected index count' end

  -- ------------------------------------------ NO FK, NO EXTRA UNIQUENESS
  union all
  select 500, 'NO foreign key on this table (school_id is unconstrained by design)',
         coalesce((select string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), '; ')
                     from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype = 'f'), 'none'),
         'none -- schools has no migration, so an FK would break clean builds',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from tbl) and c.contype = 'f')
              then 'FAIL -- an FK was added; this migration must run without public.schools'
              else 'PASS' end

  union all
  select 510, 'NO dependency on public.schools at all',
         coalesce((select string_agg(cl.relname, ', ') from pg_depend d
                     join pg_class cl on cl.oid = d.refobjid
                     join pg_namespace n on n.oid = cl.relnamespace
                    where d.objid = (select oid from tbl)
                      and n.nspname = 'public' and cl.relname = 'schools'), 'none'),
         'none',
         case when exists (select 1 from pg_depend d
                            join pg_class cl on cl.oid = d.refobjid
                            join pg_namespace n on n.oid = cl.relnamespace
                           where d.objid = (select oid from tbl)
                             and n.nspname = 'public' and cl.relname = 'schools')
              then 'FAIL -- this table now depends on schools' else 'PASS' end

  union all
  select 520, 'NO uniqueness beyond the primary key',
         coalesce((select string_agg(c.conname || ' (' || c.contype::text || ')', ', ' order by c.conname)
                     from pg_constraint c
                    where c.conrelid = (select oid from tbl) and c.contype in ('u', 'x')), 'none'),
         'none -- multiple prompts per school is the approved model',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from tbl) and c.contype in ('u', 'x'))
              then 'FAIL -- a uniqueness constraint was added' else 'PASS' end

  union all
  select 530, 'no unique INDEX either (a unique index is uniqueness without a constraint)',
         coalesce((select string_agg(i.indexname, ', ') from pg_indexes i
                    where i.schemaname = 'public' and i.tablename = 'statement_prompts'
                      and i.indexdef ilike '%unique index%'
                      and i.indexname <> 'statement_prompts_pkey'), 'none'),
         'none besides the PK''s own index',
         case when exists (select 1 from pg_indexes i
                            where i.schemaname = 'public' and i.tablename = 'statement_prompts'
                              and i.indexdef ilike '%unique index%'
                              and i.indexname <> 'statement_prompts_pkey')
              then 'FAIL' else 'PASS' end

  -- --------------------------------------------------------------------- RLS
  union all
  select 600, 'row level security ENABLED',
         coalesce((select case when c.relrowsecurity then 'enabled' else 'DISABLED' end
                     from pg_class c where c.oid = (select oid from tbl)), 'n/a'),
         'enabled',
         case when (select c.relrowsecurity from pg_class c where c.oid = (select oid from tbl))
              then 'PASS' else 'FAIL -- without RLS the SELECT grant exposes inactive rows' end

  union all
  select 610, 'exactly ONE policy exists, and it is SELECT',
         coalesce((select string_agg(p.policyname || ' [' || p.cmd || ']', ', ' order by p.policyname)
                     from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_prompts'), 'none'),
         'active statement prompt select [SELECT]',
         case when (select count(*) from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'statement_prompts') = 1
               and exists (select 1 from pg_policies p
                            where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                              and p.policyname = 'active statement prompt select'
                              and p.cmd = 'SELECT')
              then 'PASS' else 'FAIL' end

  union all
  select 620, 'the SELECT policy is ACTIVE-ONLY (inactive prompts unreadable)',
         coalesce((select coalesce(p.qual, '(no USING clause)') from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                      and p.policyname = 'active statement prompt select'), 'MISSING'),
         'is_active',
         case when (select p.qual from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                       and p.policyname = 'active statement prompt select') ilike '%is_active%'
              then 'PASS'
              else 'FAIL -- a withdrawn prompt would be readable by every applicant' end

  union all
  select 630, 'the SELECT policy applies to anon AND authenticated',
         coalesce((select array_to_string(p.roles, ', ') from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                      and p.policyname = 'active statement prompt select'), 'MISSING'),
         'anon, authenticated',
         case when (select p.roles::text from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                       and p.policyname = 'active statement prompt select') like '%anon%'
               and (select p.roles::text from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                       and p.policyname = 'active statement prompt select') like '%authenticated%'
              then 'PASS' else 'FAIL' end

  union all
  select 640, 'NO write policy of any kind (INSERT / UPDATE / DELETE / ALL)',
         coalesce((select string_agg(p.policyname || ' [' || p.cmd || ']', ', ')
                     from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                      and p.cmd <> 'SELECT'), 'none'),
         'none -- a missing policy is a denial',
         case when exists (select 1 from pg_policies p
                            where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                              and p.cmd <> 'SELECT')
              then 'FAIL -- a browser role could write the catalog the analyzer reads'
              else 'PASS' end

  union all
  select 650, 'no USING (true) anywhere (the legacy schools pattern was NOT copied)',
         coalesce((select string_agg(p.policyname, ', ') from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                      and (p.qual = 'true' or p.with_check = 'true')), 'none'),
         'none',
         case when exists (select 1 from pg_policies p
                            where p.schemaname = 'public' and p.tablename = 'statement_prompts'
                              and (p.qual = 'true' or p.with_check = 'true'))
              then 'FAIL' else 'PASS' end

  -- ------------------------------------------------------------------ GRANTS
  union all
  select 700, 'anon has SELECT',
         coalesce((select has_table_privilege('anon', (select oid from tbl), 'SELECT')::text), 'n/a'),
         'true',
         case when coalesce(has_table_privilege('anon', (select oid from tbl), 'SELECT'), false)
              then 'PASS' else 'FAIL' end

  union all
  select 701, 'authenticated has SELECT',
         coalesce((select has_table_privilege('authenticated', (select oid from tbl), 'SELECT')::text), 'n/a'),
         'true',
         case when coalesce(has_table_privilege('authenticated', (select oid from tbl), 'SELECT'), false)
              then 'PASS' else 'FAIL' end

  union all
  select 710, 'anon has NO INSERT / UPDATE / DELETE / TRUNCATE',
         coalesce((select string_agg(pr || '=' ||
                     has_table_privilege('anon', (select oid from tbl), pr)::text, ', ')
                     from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(pr)), 'n/a'),
         'all false',
         case when (select bool_or(has_table_privilege('anon', (select oid from tbl), pr))
                      from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(pr))
              then 'FAIL -- a browser role can write the prompt catalog' else 'PASS' end

  union all
  select 711, 'authenticated has NO INSERT / UPDATE / DELETE / TRUNCATE',
         coalesce((select string_agg(pr || '=' ||
                     has_table_privilege('authenticated', (select oid from tbl), pr)::text, ', ')
                     from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(pr)), 'n/a'),
         'all false',
         case when (select bool_or(has_table_privilege('authenticated', (select oid from tbl), pr))
                      from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) v(pr))
              then 'FAIL -- a signed-in applicant can fabricate prompt rows' else 'PASS' end

  union all
  -- PUBLIC IS NOT A ROLE has_table_privilege() CAN BE ASKED ABOUT. It is a
  -- pseudo-grantee: there is no pg_roles row named PUBLIC, so passing 'public'
  -- resolves to nothing and the call errors rather than answering. The grant
  -- itself is still visible, as a row whose grantee is the literal 'PUBLIC', so
  -- the catalog view is what gets read here.
  select 720, 'PUBLIC holds nothing (a PUBLIC privilege is held by every role)',
         coalesce((select string_agg(distinct g.privilege_type, ', ' order by g.privilege_type)
                     from information_schema.table_privileges g
                    where g.table_schema = 'public'
                      and g.table_name = 'statement_prompts'
                      and g.grantee = 'PUBLIC'), 'none'),
         'none',
         case when exists (select 1 from information_schema.table_privileges g
                            where g.table_schema = 'public'
                              and g.table_name = 'statement_prompts'
                              and g.grantee = 'PUBLIC')
              then 'FAIL -- PUBLIC grants reach anon' else 'PASS' end

  union all
  select 730, 'service_role holds nothing yet (the admin write path is a later checkpoint)',
         coalesce((select string_agg(pr || '=' ||
                     has_table_privilege('service_role', (select oid from tbl), pr)::text, ', ')
                     from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr)), 'n/a'),
         'all false -- nothing writes prompts yet',
         case when (select bool_or(has_table_privilege('service_role', (select oid from tbl), pr))
                      from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(pr))
              then 'FAIL -- a standing privilege with no caller' else 'PASS' end

  -- -------------------------------------------------------- no seed, no trigger
  union all
  select 800, 'the catalog is EMPTY (this migration seeds nothing)',
         coalesce((select count(*)::text from public.statement_prompts), 'n/a'),
         '0',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when (select count(*) from public.statement_prompts) = 0 then 'PASS'
              else 'FAIL -- rows were inserted; this checkpoint establishes the catalog only' end

  union all
  select 810, 'no user-defined trigger (whatever writes a prompt owns updated_at)',
         coalesce((select string_agg(t.tgname, ', ' order by t.tgname) from pg_trigger t
                    where t.tgrelid = (select oid from tbl)
                      and not t.tgisinternal and t.tgconstraint = 0), 'none'),
         'none',
         case when (select oid from tbl) is null then 'FAIL -- no table'
              when exists (select 1 from pg_trigger t
                            where t.tgrelid = (select oid from tbl)
                              and not t.tgisinternal and t.tgconstraint = 0)
              then 'FAIL -- no trigger was designed in this checkpoint' else 'PASS' end

  -- ------------------------------------------------------ untouched neighbours
  union all
  select 900, 'public.statement_drafts still has exactly 7 columns (untouched)',
         coalesce((select count(*)::text from pg_attribute a
                    where a.attrelid = to_regclass('public.statement_drafts')
                      and a.attnum > 0 and not a.attisdropped), 'absent'),
         '7 -- no draft metadata column was added in this checkpoint',
         case when to_regclass('public.statement_drafts') is null then 'INFO -- drafts absent here'
              when (select count(*) from pg_attribute a
                     where a.attrelid = to_regclass('public.statement_drafts')
                       and a.attnum > 0 and not a.attisdropped) = 7
              then 'PASS' else 'FAIL -- statement_drafts was modified' end

  union all
  select 910, 'public.schools policies unchanged in count (INFO -- context only)',
         coalesce((select count(*)::text from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'schools'), 'schools absent'),
         'whatever it was before -- this migration touches none of them',
         'INFO'
)
select step, check_name, actual, expected, verdict
from checks
order by step;

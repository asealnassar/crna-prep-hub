-- Statement Requirements (school writing-requirement catalog)
-- POST-MIGRATION VERIFICATION. READ-ONLY.
-- Run immediately after supabase/migrations/20261002_005_statement_requirements.sql.
--
-- ONE STATEMENT, deliberately: the Supabase SQL editor shows only the LAST
-- result of a multi-statement script, so every check below is unioned into a
-- single query and the whole matrix is visible at once.
--
-- PASS CONDITION: every row reads PASS, except the rows marked INFO, which are
-- context rather than assertions. A single FAIL means the migration did not land
-- as designed -- do not set STATEMENT_REQUIREMENTS.
--
-- WHAT THIS FILE CANNOT PROVE, stated before the first check rather than at the
-- end: it reads the catalog. It does not run a query as `anon`, it does not run
-- one as an applicant, and it does not evaluate an RLS predicate. So the rows
-- below establish that the POLICIES AND GRANTS EXIST AS WRITTEN and establish
-- nothing about what a browser can actually see or write. The three guarantees
-- that matter most here --
--
--   * an inactive set and its documents are invisible to an applicant,
--   * an applicant cannot write the catalog,
--   * an unverified set cannot be activated
--
-- -- are covered by supabase/tests/statement_requirements_behaviour_test.sql,
-- which writes synthetic rows and must be authorized separately. The third one
-- is the only one a read-only query can partly reach, via the constraint
-- definition, and even then it proves the CHECK exists rather than that it
-- fires.
--
-- to_regclass() is used rather than a ::regclass cast so that a missing table
-- reports as one clean FAIL instead of aborting the whole query. For the same
-- reason has_table_privilege() is called with the table OID rather than its
-- name: given a NULL oid it returns NULL, whereas the name form raises
-- 'relation does not exist' and would abort every other check with it.
--
-- Mutates nothing.

with
  sets_t   as (select to_regclass('public.statement_requirement_sets') as oid),
  reqs_t   as (select to_regclass('public.statement_requirements') as oid),
  drafts_t as (select to_regclass('public.statement_drafts') as oid),

expected_set_cols(ord, col, typ, nullable) as (
  values
    (1,  'id',                  'uuid',                     'NO'),
    (2,  'school_id',           'uuid',                     'NO'),
    (3,  'application_cycle',   'text',                     'YES'),
    (4,  'verification_status', 'text',                     'NO'),
    (5,  'source_url',          'text',                     'YES'),
    (6,  'verified_on',         'date',                     'YES'),
    (7,  'is_verbatim',         'boolean',                  'NO'),
    (8,  'original_text',       'text',                     'NO'),
    (9,  'notes',               'jsonb',                    'NO'),
    (10, 'is_active',           'boolean',                  'NO'),
    (11, 'display_order',       'integer',                  'NO'),
    (12, 'created_at',          'timestamp with time zone', 'NO'),
    (13, 'updated_at',          'timestamp with time zone', 'NO')
),

expected_req_cols(ord, col, typ, nullable) as (
  values
    (1,  'id',                        'uuid',     'NO'),
    (2,  'set_id',                    'uuid',     'NO'),
    (3,  'school_id',                 'uuid',     'NO'),
    (4,  'document_type',             'text',     'NO'),
    (5,  'label',                     'text',     'NO'),
    (6,  'prompt_text',               'text',     'NO'),
    (7,  'components',                'jsonb',    'NO'),
    (8,  'min_words',                 'integer',  'YES'),
    (9,  'max_words',                 'integer',  'YES'),
    (10, 'min_characters',            'integer',  'YES'),
    (11, 'max_characters',            'integer',  'YES'),
    (12, 'characters_include_spaces', 'boolean',  'YES'),
    (13, 'min_pages',                 'integer',  'YES'),
    (14, 'max_pages',                 'integer',  'YES'),
    (15, 'page_spacing',              'text',     'YES'),
    (16, 'font_size_pt',              'integer',  'YES'),
    (17, 'font_family',               'text',     'YES'),
    (18, 'citation_style',            'text',     'YES'),
    (19, 'citation_family',           'text',     'YES'),
    (20, 'min_references',            'integer',  'YES'),
    (21, 'other_instructions',        'jsonb',    'NO'),
    (22, 'choice_group',              'text',     'YES'),
    (23, 'is_optional',               'boolean',  'NO'),
    (24, 'notes',                     'jsonb',    'NO'),
    (25, 'is_active',                 'boolean',  'NO'),
    (26, 'display_order',             'integer',  'NO')
),

checks as (

  -- ============================================ 1. THE TABLES
  select 100 as step,
         'public.statement_requirement_sets exists' as check_name,
         coalesce((select oid::text from sets_t), 'absent') as actual,
         'present' as expected,
         case when (select oid from sets_t) is null
              then 'FAIL -- 005 did not land' else 'PASS' end as verdict

  union all
  select 101,
         'public.statement_requirements exists',
         coalesce((select oid::text from reqs_t), 'absent'),
         'present',
         case when (select oid from reqs_t) is null then 'FAIL -- 005 did not land' else 'PASS' end

  -- ============================================ 2. COLUMNS
  union all
  select 200 + e.ord,
         format('sets.%s', e.col),
         coalesce(c.data_type, 'absent') || coalesce(' / nullable=' || c.is_nullable, ''),
         format('%s / nullable=%s', e.typ, e.nullable),
         case when c.column_name is null then 'FAIL -- column missing'
              when c.data_type <> e.typ then 'FAIL -- wrong type'
              when c.is_nullable <> e.nullable then 'FAIL -- wrong nullability'
              else 'PASS' end
    from expected_set_cols e
    left join information_schema.columns c
           on c.table_schema = 'public' and c.table_name = 'statement_requirement_sets'
          and c.column_name = e.col

  union all
  select 300 + e.ord,
         format('requirements.%s', e.col),
         coalesce(c.data_type, 'absent') || coalesce(' / nullable=' || c.is_nullable, ''),
         format('%s / nullable=%s', e.typ, e.nullable),
         case when c.column_name is null then 'FAIL -- column missing'
              when c.data_type <> e.typ then 'FAIL -- wrong type'
              when c.is_nullable <> e.nullable then 'FAIL -- wrong nullability'
              else 'PASS' end
    from expected_req_cols e
    left join information_schema.columns c
           on c.table_schema = 'public' and c.table_name = 'statement_requirements'
          and c.column_name = e.col

  -- NO COLUMN DERIVES ONE UNIT FROM ANOTHER. A words-per-page estimate column
  -- would be this product inventing an admissions requirement.
  union all
  select 390,
         'no estimated/derived length column exists',
         coalesce((select string_agg(column_name, ', ') from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and (column_name like '%estimate%' or column_name like '%per_page%'
                           or column_name like '%equivalent%')), 'none'),
         'none',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'statement_requirements'
                              and (column_name like '%estimate%' or column_name like '%per_page%'
                                   or column_name like '%equivalent%'))
              then 'FAIL -- a unit is being derived from another' else 'PASS' end

  -- ============================================ 3. REQUIREMENT-SET VERIFICATION RULES
  --
  -- THE EDITORIAL RULE, IN THE DATABASE. An active set must be verified and
  -- must carry a source and a date. This is the second, independent answer to
  -- "could somebody publish an unverified requirement" -- the first being that
  -- no browser role can write the table at all.
  union all
  select 400,
         'constraint: an ACTIVE set must be verified, sourced and dated',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from sets_t)
                      and c.conname = 'statement_requirement_sets_active_needs_evidence'),
                  'absent'),
         'is_active = false OR (verification_status = verified AND source_url IS NOT NULL '
         || 'AND verified_on IS NOT NULL)',
         case
           when not exists (select 1 from pg_constraint c
                             where c.conrelid = (select oid from sets_t)
                               and c.conname = 'statement_requirement_sets_active_needs_evidence')
             then 'FAIL -- an unverified set could be activated'
           when (select pg_get_constraintdef(c.oid) from pg_constraint c
                  where c.conrelid = (select oid from sets_t)
                    and c.conname = 'statement_requirement_sets_active_needs_evidence')
                like '%verification_status%verified%'
            and (select pg_get_constraintdef(c.oid) from pg_constraint c
                  where c.conrelid = (select oid from sets_t)
                    and c.conname = 'statement_requirement_sets_active_needs_evidence')
                like '%source_url IS NOT NULL%'
            and (select pg_get_constraintdef(c.oid) from pg_constraint c
                  where c.conrelid = (select oid from sets_t)
                    and c.conname = 'statement_requirement_sets_active_needs_evidence')
                like '%verified_on IS NOT NULL%'
             then 'PASS -- but see the behavioural test: this proves the CHECK EXISTS, '
                  || 'not that it fires'
           else 'FAIL -- the constraint exists but does not require all three'
         end

  union all
  select 401,
         'constraint: verification_status is restricted to the four known values',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from sets_t)
                      and c.conname = 'statement_requirement_sets_status_known'), 'absent'),
         'unverified / needs-review / verified / conflicting',
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from sets_t)
                       and c.conname = 'statement_requirement_sets_status_known')
                   like '%conflicting%'
              then 'PASS' else 'FAIL -- an unrecognised status could be stored' end

  union all
  select 402,
         'verification_status defaults to unverified',
         coalesce((select column_default from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirement_sets'
                      and column_name = 'verification_status'), 'none'),
         '''unverified''::text',
         case when coalesce((select column_default from information_schema.columns
                              where table_schema = 'public'
                                and table_name = 'statement_requirement_sets'
                                and column_name = 'verification_status'), '')
                   like '%unverified%'
              then 'PASS' else 'FAIL -- a row with no status must not default to verified' end

  union all
  select 403,
         'no source_url or verified_on default is invented',
         coalesce((select string_agg(column_name || '=' || coalesce(column_default, 'null'), ', ')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirement_sets'
                      and column_name in ('source_url', 'verified_on')), 'absent'),
         'both default to null',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'statement_requirement_sets'
                              and column_name in ('source_url', 'verified_on')
                              and column_default is not null)
              then 'FAIL -- evidence must be recorded, never defaulted'
              else 'PASS' end

  -- ============================================ 4. REQUIREMENT IDENTITY AND SCHOOL ASSOCIATION
  union all
  select 500,
         'requirements.set_id references statement_requirement_sets ON DELETE CASCADE',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from reqs_t) and c.contype = 'f'), 'absent'),
         'FOREIGN KEY (set_id) REFERENCES statement_requirement_sets(id) ON DELETE CASCADE',
         case when (select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = (select oid from reqs_t) and c.contype = 'f')
                   like '%statement_requirement_sets(id) ON DELETE CASCADE'
              then 'PASS' else 'FAIL -- a document could outlive its set' end

  union all
  select 501,
         'requirements.school_id is NOT NULL (denormalised from the set)',
         coalesce((select is_nullable from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_requirements'
                      and column_name = 'school_id'), 'absent'),
         'NO',
         case when (select is_nullable from information_schema.columns
                     where table_schema = 'public' and table_name = 'statement_requirements'
                       and column_name = 'school_id') = 'NO'
              then 'PASS' else 'FAIL -- a requirement with no school cannot be attributed' end

  -- NO FK TO public.schools, deliberately: that table predates the migrations
  -- directory and exists only in production, so a REFERENCES clause would make
  -- the file fail everywhere except there.
  union all
  select 502,
         'no foreign key to public.schools (INFO -- deliberate)',
         coalesce((select count(*)::text from pg_constraint c
                    join pg_class r on r.oid = c.confrelid
                   where c.conrelid in ((select oid from sets_t), (select oid from reqs_t))
                     and r.relname = 'schools'), '0'),
         '0',
         'INFO -- school_id is a bare uuid on purpose; the FK is a follow-up once '
         || 'public.schools is under migration control'

  union all
  select 503,
         'document_type is restricted to the known set',
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from reqs_t)
                      and c.conname = 'statement_requirements_document_type_known'), 'absent'),
         'a CHECK listing the document types',
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from reqs_t)
                              and c.conname = 'statement_requirements_document_type_known')
              then 'PASS' else 'FAIL -- an arbitrary document type could be stored' end

  -- ============================================ 5. SNAPSHOT CONSTRAINTS ON statement_drafts
  union all
  select 600 + x.ord,
         format('statement_drafts.%s exists and is NULLABLE', x.col),
         coalesce((select data_type || ' / nullable=' || is_nullable
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'statement_drafts'
                      and column_name = x.col), 'absent'),
         format('%s / nullable=YES', x.typ),
         case
           when not exists (select 1 from information_schema.columns
                             where table_schema = 'public' and table_name = 'statement_drafts'
                               and column_name = x.col) then 'FAIL -- column missing'
           when (select is_nullable from information_schema.columns
                  where table_schema = 'public' and table_name = 'statement_drafts'
                    and column_name = x.col) <> 'YES'
             then 'FAIL -- NOT NULL would have invalidated every existing draft'
           else 'PASS'
         end
    from (values (1, 'requirement_id', 'uuid'), (2, 'requirement_snapshot', 'jsonb'))
         as x(ord, col, typ)

  union all
  select 610 + x.ord,
         format('constraint %s', x.conname),
         coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                    where c.conrelid = (select oid from drafts_t) and c.conname = x.conname),
                  'absent'),
         x.want,
         case when exists (select 1 from pg_constraint c
                            where c.conrelid = (select oid from drafts_t)
                              and c.conname = x.conname)
              then 'PASS' else format('FAIL -- %s', x.why) end
    from (values
      (1, 'statement_drafts_requirement_snapshot_object',
          'the snapshot is a json object or null',
          'a snapshot could be an array or a scalar'),
      (2, 'statement_drafts_requirement_pair',
          'requirement_id and requirement_snapshot are both set or both null',
          'a draft could carry an id with no snapshot, or a snapshot with no id'),
      (3, 'statement_drafts_one_prompt_source',
          'prompt_id and requirement_id are never both set',
          'a draft could claim two different prompt sources'),
      (4, 'statement_drafts_requirement_needs_prompt_text',
          'a requirement-backed draft carries a school and wording',
          'a requirement-backed draft could have no question in it')
    ) as x(ord, conname, want, why)

  -- NO FK FROM statement_drafts.requirement_id, deliberately: a requirement may
  -- be deleted or superseded and the draft must survive with its snapshot
  -- intact. A REFERENCES clause would block the delete or cascade away an essay.
  union all
  select 620,
         'no foreign key from statement_drafts.requirement_id (INFO -- deliberate)',
         coalesce((select count(*)::text from pg_constraint c
                    join pg_class r on r.oid = c.confrelid
                   where c.conrelid = (select oid from drafts_t)
                     and r.relname in ('statement_requirements', 'statement_requirement_sets')),
                  '0'),
         '0',
         case when exists (select 1 from pg_constraint c
                            join pg_class r on r.oid = c.confrelid
                           where c.conrelid = (select oid from drafts_t)
                             and r.relname in ('statement_requirements',
                                               'statement_requirement_sets'))
              then 'FAIL -- deleting a requirement could block or destroy a draft'
              else 'INFO -- as designed; the draft holds a frozen snapshot instead' end

  -- ============================================ 6. CATALOG VISIBILITY (RLS)
  union all
  select 700 + x.ord,
         format('row level security is enabled on %s', x.tbl),
         coalesce((select relrowsecurity::text from pg_class
                    where oid = to_regclass('public.' || x.tbl)), 'unknown'),
         'true',
         case when (select relrowsecurity from pg_class
                     where oid = to_regclass('public.' || x.tbl)) is true
              then 'PASS' else 'FAIL -- RLS is off; every grant is table-wide' end
    from (values (1, 'statement_requirement_sets'), (2, 'statement_requirements'))
         as x(ord, tbl)

  union all
  select 710 + x.ord,
         format('%s has exactly one policy, and it is SELECT', x.tbl),
         coalesce((select count(*)::text || ' / ' || coalesce(string_agg(cmd, ','), '')
                     from pg_policies
                    where schemaname = 'public' and tablename = x.tbl), '0 / none'),
         '1 / SELECT',
         case
           when (select count(*) from pg_policies
                  where schemaname = 'public' and tablename = x.tbl) <> 1
             then 'FAIL -- an extra policy is an extra way in'
           when (select cmd from pg_policies
                  where schemaname = 'public' and tablename = x.tbl limit 1) <> 'SELECT'
             then 'FAIL -- a write policy exists on reference data'
           else 'PASS'
         end
    from (values (1, 'statement_requirement_sets'), (2, 'statement_requirements'))
         as x(ord, tbl)

  -- INACTIVE VERSUS ACTIVE. The predicate is recorded for a human to read. It
  -- is NOT an assertion that an inactive row is hidden -- a predicate that
  -- LOOKS right is not a predicate that was exercised.
  union all
  select 720,
         'sets policy predicate (INFO -- read it; the behavioural test exercises it)',
         coalesce((select coalesce(qual, '(none)') from pg_policies
                    where schemaname = 'public' and tablename = 'statement_requirement_sets'
                    limit 1), 'absent'),
         'is_active',
         case when coalesce((select qual from pg_policies
                              where schemaname = 'public'
                                and tablename = 'statement_requirement_sets' limit 1), '')
                   like '%is_active%'
              then 'INFO -- names is_active, as designed'
              else 'FAIL -- the active-only rule is not in the policy' end

  union all
  select 721,
         'requirements policy also requires the SET to be active (INFO -- read it)',
         coalesce((select coalesce(qual, '(none)') from pg_policies
                    where schemaname = 'public' and tablename = 'statement_requirements'
                    limit 1), 'absent'),
         'is_active AND EXISTS (... s.is_active)',
         case when coalesce((select qual from pg_policies
                              where schemaname = 'public'
                                and tablename = 'statement_requirements' limit 1), '')
                   like '%statement_requirement_sets%'
              then 'INFO -- a document is invisible once its set is deactivated, as designed'
              else 'FAIL -- a withdrawn requirement would leak back into a picker' end

  -- ============================================ 7. UNAUTHORIZED CATALOG WRITES
  union all
  select 800 + x.ord,
         format('%s may SELECT %s', x.role, x.tbl),
         coalesce(has_table_privilege(x.role, to_regclass('public.' || x.tbl), 'SELECT')::text,
                  'unknown'),
         'true',
         case when has_table_privilege(x.role, to_regclass('public.' || x.tbl), 'SELECT') is true
              then 'PASS' else 'FAIL -- the picker cannot read the catalog' end
    from (values (1, 'anon', 'statement_requirement_sets'),
                 (2, 'anon', 'statement_requirements'),
                 (3, 'authenticated', 'statement_requirement_sets'),
                 (4, 'authenticated', 'statement_requirements')) as x(ord, role, tbl)

  union all
  select 810 + x.ord,
         format('%s has NO %s on %s', x.role, x.priv, x.tbl),
         coalesce(has_table_privilege(x.role, to_regclass('public.' || x.tbl), x.priv)::text,
                  'unknown'),
         'false',
         case when has_table_privilege(x.role, to_regclass('public.' || x.tbl), x.priv) is true
              then 'FAIL -- a browser could write reference data that feeds the analyser'
              else 'PASS' end
    from (select row_number() over () as ord, role, priv, tbl
            from (values ('anon'), ('authenticated')) r(role)
            cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
            cross join (values ('statement_requirement_sets'), ('statement_requirements')) t(tbl)
         ) as x

  -- service_role BYPASSES RLS. Nothing writes these tables from application
  -- code, so a standing privilege here would have no caller.
  union all
  select 840 + x.ord,
         format('service_role has NO %s on %s', x.priv, x.tbl),
         coalesce(has_table_privilege('service_role', to_regclass('public.' || x.tbl),
                                      x.priv)::text, 'unknown'),
         'false',
         case when has_table_privilege('service_role', to_regclass('public.' || x.tbl),
                                       x.priv) is true
              then 'FAIL -- service_role bypasses RLS; revoke it'
              else 'PASS' end
    from (select row_number() over () as ord, priv, tbl
            from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
            cross join (values ('statement_requirement_sets'), ('statement_requirements')) t(tbl)
         ) as x

  union all
  select 870 + x.ord,
         format('PUBLIC holds nothing on %s', x.tbl),
         coalesce((select string_agg(distinct privilege_type, ', ')
                     from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = x.tbl
                      and grantee = 'PUBLIC'), 'none'),
         'none',
         case when exists (select 1 from information_schema.role_table_grants
                            where table_schema = 'public' and table_name = x.tbl
                              and grantee = 'PUBLIC')
              then 'FAIL -- PUBLIC is held by every role including anon'
              else 'PASS' end
    from (values (1, 'statement_requirement_sets'), (2, 'statement_requirements'))
         as x(ord, tbl)

  -- ============================================ 8. LEGACY DRAFT COMPATIBILITY
  --
  -- THE REASON THIS SECTION EXISTS: 005 adds four CHECK constraints to a table
  -- that already holds somebody's work, none of them NOT VALID. If the ALTER
  -- succeeded, PostgreSQL has already validated every row -- so these counts
  -- are a cross-check and a record, not a discovery.
  union all
  select 900,
         'statement_drafts row count (COMPARE WITH THE PREFLIGHT)',
         coalesce((select count(*)::text from public.statement_drafts), 'unreadable'),
         'identical to the preflight',
         'INFO -- any change means something other than this migration ran'

  union all
  select 901,
         'every existing draft has requirement_id NULL',
         coalesce((select count(*)::text from public.statement_drafts
                    where requirement_id is not null), 'unreadable'),
         '0',
         case when (select count(*) from public.statement_drafts
                     where requirement_id is not null) = 0
              then 'PASS -- no draft was retroactively given a requirement'
              else 'INFO -- requirement-backed drafts already exist; not a fresh apply' end

  union all
  select 902,
         'no draft violates the pair rule',
         coalesce((select count(*)::text from public.statement_drafts
                    where (requirement_id is null) <> (requirement_snapshot is null)),
                  'unreadable'),
         '0',
         case when (select count(*) from public.statement_drafts
                     where (requirement_id is null) <> (requirement_snapshot is null)) = 0
              then 'PASS' else 'FAIL -- the CHECK should have made this impossible' end

  union all
  select 903,
         'no draft carries both a prompt_id and a requirement_id',
         coalesce((select count(*)::text from public.statement_drafts
                    where prompt_id is not null and requirement_id is not null), 'unreadable'),
         '0',
         case when (select count(*) from public.statement_drafts
                     where prompt_id is not null and requirement_id is not null) = 0
              then 'PASS' else 'FAIL -- the CHECK should have made this impossible' end

  union all
  select 904,
         'legacy prompt-backed drafts are still intact',
         coalesce((select count(*)::text from public.statement_drafts
                    where prompt_id is not null), 'unreadable'),
         'identical to the preflight',
         'INFO -- compare with preflight step 202'

  union all
  select 905,
         'statement_drafts grants (COMPARE WITH THE PREFLIGHT -- must be identical)',
         coalesce((select string_agg(distinct grantee || '.' || privilege_type, ', '
                                     order by grantee || '.' || privilege_type)
                     from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = 'statement_drafts'
                      and grantee not in ('postgres', 'supabase_admin')), 'none'),
         'identical to the preflight',
         'INFO -- 005 adds no column-level grant; any difference is a finding'

  -- THE PROMPT CATALOG MUST BE UNTOUCHED. 005 names statement_prompts in no
  -- DDL statement, so the live Arkansas State row cannot have moved.
  union all
  select 910,
         'public.statement_prompts row count (COMPARE WITH THE PREFLIGHT)',
         case when to_regclass('public.statement_prompts') is null then 'absent'
              else coalesce((select count(*)::text from public.statement_prompts), 'unreadable')
         end,
         'identical to the preflight',
         'INFO -- 005 alters this table in no statement; a difference is a finding'

  union all
  select 911,
         'active prompts (COMPARE WITH THE PREFLIGHT -- includes Arkansas State)',
         case when to_regclass('public.statement_prompts') is null then 'n/a'
              else coalesce((select count(*)::text from public.statement_prompts
                              where is_active), 'unreadable') end,
         'identical to the preflight',
         'INFO'

  -- ============================================ 9. INDEXES AND EMPTINESS
  union all
  select 950 + x.ord,
         format('index %s', x.idx),
         case when exists (select 1 from pg_indexes where schemaname = 'public'
                            and indexname = x.idx) then 'present' else 'absent' end,
         'present',
         case when exists (select 1 from pg_indexes where schemaname = 'public'
                            and indexname = x.idx) then 'PASS' else 'FAIL -- index missing' end
    from (values (1, 'statement_requirement_sets_school_active_order_idx'),
                 (2, 'statement_requirements_set_active_order_idx')) as x(ord, idx)

  union all
  select 960,
         'both new tables are empty (INFO -- expected right after the migration)',
         coalesce((select count(*)::text from public.statement_requirement_sets), '?')
           || ' sets / '
           || coalesce((select count(*)::text from public.statement_requirements), '?')
           || ' requirements',
         '0 sets / 0 requirements',
         case when (select count(*) from public.statement_requirement_sets) = 0
               and (select count(*) from public.statement_requirements) = 0
              then 'INFO -- as expected; the catalog is populated deliberately, later'
              else 'INFO -- rows already present; this is not a fresh apply' end

  -- ============================================ 10. WHAT IS NOT PROVEN HERE
  union all
  select 990,
         'runtime visibility and write refusal (INFO -- NOT CHECKED HERE)',
         'not checked',
         'see supabase/tests/statement_requirements_behaviour_test.sql',
         'INFO -- every row above reads the catalog. Nothing ran a query as anon or '
         || 'as an applicant, nothing evaluated an RLS predicate, and nothing attempted '
         || 'a write. Inactive-set invisibility, catalog write refusal and the '
         || 'unverified-activation refusal are behavioural and need that test.'

  union all
  select 991,
         'the snapshot tampering surface (INFO -- READ THIS)',
         'statement_drafts grants authenticated table-level UPDATE',
         'defended in the application, not in the database',
         'INFO -- an applicant CAN patch their own requirement_snapshot over PostgREST. '
         || 'What stops a forged VERIFIED requirement is lib/statement/requirements/'
         || 'provenance.ts comparing the whole snapshot against a catalog reconstruction, '
         || 'and the analyse route acting only on the authenticated value. That is '
         || 'TypeScript, not SQL, and no query here can establish it.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;

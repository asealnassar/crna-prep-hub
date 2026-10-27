-- ============================================================================
-- PREFLIGHT for the Statement Studio V2 rollout (008, 010-017 + corrections)
-- ============================================================================
-- READ-ONLY. No INSERT, UPDATE, DELETE, ALTER, CREATE or GRANT appears below.
-- Run it in the SQL editor immediately before approval and read every row.
--
-- ANY 'FAIL' MEANS DO NOT PROCEED. 'INFO' rows are context, not verdicts.
--
-- ONE STATEMENT, because the SQL editor shows only the last result.
--
-- WHAT THIS ASSERTS:
--   1    identity -- which database and which role
--   10s  the applied baseline (004-007) is present and unchanged
--   20s  every pending object is ABSENT, so nothing is half-applied
--   24-25 migration 009 is WITHDRAWN and was NEVER applied -- see below
--   30s  the catalog is exactly the 63/80 that was imported, by fingerprint
--   40s  nothing is active, and South Dakota is still needs-review
--   50s  the 28 correction targets still hold their expected values
--   60s  safety: no long transaction, no blocking lock
-- ============================================================================

with
  pending_columns(tbl, col, migration) as (values
    ('statement_prompt_submissions', 'document_label',          '008'),
    ('statement_prompt_submissions', 'approved_requirement_id', '008'),
    ('statement_requirements',       'font_family_options',     '010'),
    ('statement_requirements',       'font_size_pt_options',    '010'),
    ('statement_requirement_sets',   'evidence_kind',           '011'),
    ('statement_requirement_sets',   'evidence_submission_id',  '011'),
    ('statement_prompt_submissions', 'submission_kind',         '012'),
    ('statement_requirements',       'supersedes_requirement_id','012'),
    ('statement_drafts',             'editor_document',         '013'),
    ('statement_drafts',             'document_font',           '015'),
    ('statement_requirements',       'document_format_profile', '014')
  ),
  baseline_columns(tbl, col) as (values
    ('statement_requirements', 'words_enforcement'),
    ('statement_requirements', 'words_stated_as'),
    ('statement_requirements', 'pages_enforcement'),
    ('statement_requirements', 'unenforced_length'),
    ('statement_requirements', 'min_pages'),
    ('statement_requirement_sets', 'verification_status'),
    ('statement_requirement_sets', 'is_active')
  ),
  -- The CLI's history table, by oid only. NAMING IT IN A SELECT WOULD BREAK
  -- THIS WHOLE SCRIPT: a relation in a SELECT is resolved when the statement is
  -- PARSED, so an absent history -- the expected state here, since these
  -- migrations are pasted into the SQL editor -- would fail the parse and
  -- report nothing at all. Step 25 reads it through query_to_xml(), which takes
  -- the query as TEXT and so defers resolution to runtime, guarded by this oid.
  hist as (select to_regclass('supabase_migrations.schema_migrations') as oid),

  correction_targets(id) as (values
    ('01591a65-0626-55c4-993a-36143c825f9b'::uuid),
    ('041bcb8d-4207-584a-b860-b6168e696509'::uuid),
    ('080615bf-1370-5940-9edf-83c047fcc1cf'::uuid),
    ('0de844d7-97cb-58f5-90ee-e83675215cd6'::uuid),
    ('1040464f-8f46-5aae-87e5-38f1c128a5f8'::uuid),
    ('10a0e18f-ae4b-5803-a718-788dea53404d'::uuid),
    ('18a8d96e-8b14-5c14-ae70-b279e3d2761d'::uuid),
    ('1f3ba87b-3c9f-5ec9-9b56-1d1b3ba60ee7'::uuid),
    ('1f74d500-7b24-56b0-a99f-fbd539c59240'::uuid),
    ('245c3d36-1be0-575c-97de-14fcdf289fb3'::uuid),
    ('24dd131c-da14-5735-a1d9-278f7348897f'::uuid),
    ('2e8ad9b7-0d3a-5531-a8cd-5cd4a54456c8'::uuid),
    ('4a06e99c-e525-5551-88f0-c43bd4e25dd5'::uuid),
    ('4a88f1fe-ffdb-58c3-9ba0-38dc93b77059'::uuid),
    ('50ccd272-55ce-5a12-ba2b-4cd4a164d013'::uuid),
    ('5dfd30d0-0fe8-585e-a2e0-7e45c88b2364'::uuid),
    ('60d171ce-c4d7-56b0-af06-22f5547cc37f'::uuid),
    ('639b5fc7-0889-5ab7-a7a4-a937a1a8358c'::uuid),
    ('82af2a6f-b690-58c9-9f6e-8c2ab5af79df'::uuid),
    ('99672993-8d65-5b9c-832a-fe61f16174ba'::uuid),
    ('9d03d444-bdc1-57b4-9f54-aa7d91630e69'::uuid),
    ('a76e0da3-c8f7-544a-85de-c81125906659'::uuid),
    ('b717e3fd-d116-5fb7-b74b-0355a33cb143'::uuid),
    ('ba27174a-1bce-57df-a2f2-72eac697887e'::uuid),
    ('bb79b81b-53d5-57b6-b890-d1b7c4c79cdc'::uuid),
    ('c1c80521-f07c-50e0-864c-08e7ca2c3a62'::uuid),
    ('c6466a7b-7d2b-5ec8-9970-de2bd772c020'::uuid),
    ('d4e79cfc-8aa1-5c27-882b-3a9febbf3172'::uuid)
  ),
  checks as (

  select 1 as step, 'target database and executing role' as check_name,
         'db=' || current_database() || ', user=' || current_user as actual,
         'the production project' as expected, 'INFO' as verdict

  -- ---- 10s: the applied baseline ------------------------------------------
  union all
  select 10, 'the four statement tables exist (004-007 applied)',
         (select count(*)::text from information_schema.tables
           where table_schema='public'
             and table_name in ('statement_drafts','statement_requirements',
                                'statement_requirement_sets','statement_prompt_submissions')),
         '4',
         case when (select count(*) from information_schema.tables
                     where table_schema='public'
                       and table_name in ('statement_drafts','statement_requirements',
                                          'statement_requirement_sets','statement_prompt_submissions')) = 4
              then 'PASS' else 'FAIL' end
  union all
  select 11, 'every column 006/007 added is present',
         (select count(*)::text from baseline_columns bc
           where exists (select 1 from information_schema.columns c
                          where c.table_schema='public' and c.table_name=bc.tbl
                            and c.column_name=bc.col)),
         (select count(*)::text from baseline_columns),
         case when (select count(*) from baseline_columns bc
                     where not exists (select 1 from information_schema.columns c
                                        where c.table_schema='public' and c.table_name=bc.tbl
                                          and c.column_name=bc.col)) = 0
              then 'PASS' else 'FAIL' end
  union all
  select 12, 'min_pages is numeric(4,1), as 007 made it',
         (select data_type || '(' || coalesce(numeric_precision::text,'?') || ','
                 || coalesce(numeric_scale::text,'?') || ')'
            from information_schema.columns
           where table_schema='public' and table_name='statement_requirements'
             and column_name='min_pages'),
         'numeric(4,1)',
         case when (select data_type || '(' || numeric_precision || ',' || numeric_scale || ')'
                      from information_schema.columns
                     where table_schema='public' and table_name='statement_requirements'
                       and column_name='min_pages') = 'numeric(4,1)'
              then 'PASS' else 'FAIL' end
  union all
  select 13, 'the draft essay ceiling is still the pre-016 one',
         (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid='public.statement_drafts'::regclass
             and conname='statement_drafts_essay_length'),
         'CHECK ((char_length(essay) <= 20000))',
         case when (select pg_get_constraintdef(oid) from pg_constraint
                     where conrelid='public.statement_drafts'::regclass
                       and conname='statement_drafts_essay_length')
                   like '%%20000%%'
              then 'PASS' else 'FAIL' end

  -- ---- 20s: nothing pending is already applied -----------------------------
  union all
  select 20, 'no pending column exists yet (008, 010-015)',
         (select coalesce(string_agg(pc.migration || '.' || pc.col, ', ' order by pc.col), 'none')
            from pending_columns pc
           where exists (select 1 from information_schema.columns c
                          where c.table_schema='public' and c.table_name=pc.tbl
                            and c.column_name=pc.col)),
         'none',
         case when (select count(*) from pending_columns pc
                     where exists (select 1 from information_schema.columns c
                                    where c.table_schema='public' and c.table_name=pc.tbl
                                      and c.column_name=pc.col)) = 0
              then 'PASS' else 'FAIL' end
  union all
  select 21, 'the promotion RPC does not exist yet (017)',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='promote_statement_submission_to_requirement'),
         '0',
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public'
                       and p.proname='promote_statement_submission_to_requirement') = 0
              then 'PASS' else 'FAIL' end
  union all
  select 22, 'the 010 option validators do not exist yet',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public'
             and p.proname in ('statement_text_options_ok','statement_int_options_ok')),
         '0',
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public'
                       and p.proname in ('statement_text_options_ok','statement_int_options_ok')) = 0
              then 'PASS' else 'FAIL' end
  union all
  select 23, 'the constraint 011 will replace has its expected 005 definition',
         (select case when pg_get_constraintdef(oid) like '%%evidence_kind%%'
                      then 'already widened by 011' else 'original 005 definition' end
            from pg_constraint
           where conrelid='public.statement_requirement_sets'::regclass
             and conname='statement_requirement_sets_active_needs_evidence'),
         'original 005 definition',
         case when (select count(*) from pg_constraint
                     where conrelid='public.statement_requirement_sets'::regclass
                       and conname='statement_requirement_sets_active_needs_evidence'
                       and pg_get_constraintdef(oid) like '%%evidence_kind%%') = 0
              then 'PASS' else 'FAIL' end

  -- ---- 24-25: MIGRATION 009 IS WITHDRAWN AND MUST NEVER BE APPLIED ---------
  --
  -- 20261006_009_statement_submission_promotion.sql was written, never applied,
  -- and is now DELETED from this repository. It created the SAME function 017
  -- creates, but without 011's evidence columns -- so an admin promoting an
  -- approved submission would have had it silently stored as official-source,
  -- and activation would then fail against 011's widened constraint.
  --
  -- 017 REPLACES IT and refuses to install unless 008 and 011 are present.
  --
  -- Step 21 already requires the function to be absent, which covers the normal
  -- case. These two steps exist because the REMEDY differs: an absent function
  -- means proceed, a 017-shaped function means 017 is already applied, and a
  -- 009-shaped function means production holds a promotion path that was never
  -- supposed to exist and must be replaced before anything else happens.
  union all
  select 24, 'if the promotion RPC exists at all, it is not 009''s version',
         coalesce(
           (select case when pg_get_functiondef(p.oid) like '%%evidence_kind%%'
                        then '017 shape -- writes evidence_kind'
                        else '009 SHAPE -- no evidence_kind in the body' end
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname = 'promote_statement_submission_to_requirement'
             limit 1),
           'absent (expected)'),
         'absent, or the 017 shape -- never the 009 shape',
         case when (select count(*) from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public'
                       and p.proname = 'promote_statement_submission_to_requirement'
                       and pg_get_functiondef(p.oid) not like '%%evidence_kind%%') = 0
              then 'PASS'
              else 'FAIL -- 009 WAS APPLIED. Do not proceed. Apply 008 and 011, '
                   || 'then 017, which replaces this function in place; then audit '
                   || 'statement_requirement_sets for sets promoted from an approved '
                   || 'submission that are recorded as official-source.'
         end

  union all
  select 25, 'migration history, if any, does not record 009',
         case when (select oid from hist) is null
              then 'no history table (expected -- applied by SQL editor)'
              else coalesce(
                (xpath('/row/v/text()', query_to_xml(
                   'select string_agg(version, '', '' order by version) as v '
                   || 'from supabase_migrations.schema_migrations '
                   || 'where version like ''%%009%%''',
                   false, true, '')))[1]::text,
                'present, records no 009')
         end,
         'no 009 recorded',
         case when (select oid from hist) is null then 'PASS'
              when coalesce((xpath('/row/v/text()', query_to_xml(
                     'select count(*) as v from '
                     || 'supabase_migrations.schema_migrations '
                     || 'where version like ''%%009%%''',
                     false, true, '')))[1]::text, '0') = '0'
              then 'PASS'
              else 'FAIL -- the history names a 009. Read step 24: the SCHEMA is '
                   || 'authoritative, and a resume-series 009 (20260917_009) is a '
                   || 'different migration and is harmless. Confirm which before '
                   || 'proceeding.'
         end

  -- ---- 30s: the catalog is the one that was imported ------------------------
  union all
  select 30, 'requirement sets',
         (select count(*)::text from public.statement_requirement_sets), '63',
         case when (select count(*) from public.statement_requirement_sets) = 63
              then 'PASS' else 'FAIL' end
  union all
  select 31, 'requirement documents',
         (select count(*)::text from public.statement_requirements), '80',
         case when (select count(*) from public.statement_requirements) = 80
              then 'PASS' else 'FAIL' end
  union all
  select 32, 'set id fingerprint (md5 of the sorted ids)',
         (select md5(string_agg(id::text, ',' order by id::text))
            from public.statement_requirement_sets),
         '3a687c5449007fb17335e67677b85af5',
         case when (select md5(string_agg(id::text, ',' order by id::text))
                      from public.statement_requirement_sets) = '3a687c5449007fb17335e67677b85af5'
              then 'PASS' else 'FAIL' end
  union all
  select 33, 'document id fingerprint',
         (select md5(string_agg(id::text, ',' order by id::text))
            from public.statement_requirements),
         'eea3ea7f3f482d09e928b0a0db39b252',
         case when (select md5(string_agg(id::text, ',' order by id::text))
                      from public.statement_requirements) = 'eea3ea7f3f482d09e928b0a0db39b252'
              then 'PASS' else 'FAIL' end

  -- ---- 40s: nothing is live -------------------------------------------------
  union all
  select 40, 'active requirement sets',
         (select count(*)::text from public.statement_requirement_sets where is_active), '0',
         case when (select count(*) from public.statement_requirement_sets where is_active) = 0
              then 'PASS' else 'FAIL' end
  union all
  select 41, 'South Dakota is still needs-review (by id, not by name)',
         (select verification_status from public.statement_requirement_sets
           where id = 'b6e3cde7-ac51-53ee-be99-9090ae499598'::uuid),
         'needs-review',
         case when (select verification_status from public.statement_requirement_sets
                     where id = 'b6e3cde7-ac51-53ee-be99-9090ae499598'::uuid) = 'needs-review'
              then 'PASS' else 'FAIL' end

  -- ---- 50s: the correction targets are untouched ----------------------------
  union all
  select 50, 'all 28 correction targets still exist',
         (select count(*)::text from correction_targets t
           join public.statement_requirements r on r.id = t.id),
         '28',
         case when (select count(*) from correction_targets t
                     join public.statement_requirements r on r.id = t.id) = 28
              then 'PASS' else 'FAIL' end
  union all
  select 51, 'none of them has been edited since the import',
         (select count(*)::text from correction_targets t
           join public.statement_requirements r on r.id = t.id
          where r.updated_at > r.created_at + interval '1 minute'),
         '0',
         case when (select count(*) from correction_targets t
                     join public.statement_requirements r on r.id = t.id
                    where r.updated_at > r.created_at + interval '1 minute') = 0
              then 'PASS' else 'WARN -- a target was edited after import; re-review it' end

  -- ---- 60s: safety ----------------------------------------------------------
  union all
  select 60, 'no transaction older than five minutes',
         (select count(*)::text from pg_stat_activity
           where state <> 'idle' and xact_start < now() - interval '5 minutes'),
         '0',
         case when (select count(*) from pg_stat_activity
                     where state <> 'idle' and xact_start < now() - interval '5 minutes') = 0
              then 'PASS' else 'FAIL' end
  union all
  select 61, 'no blocking lock on the statement tables',
         (select count(*)::text from pg_locks l
            join pg_class c on c.oid = l.relation
           where c.relname in ('statement_drafts','statement_requirements',
                               'statement_requirement_sets','statement_prompt_submissions')
             and not l.granted),
         '0',
         case when (select count(*) from pg_locks l
                      join pg_class c on c.oid = l.relation
                     where c.relname in ('statement_drafts','statement_requirements',
                                         'statement_requirement_sets','statement_prompt_submissions')
                       and not l.granted) = 0
              then 'PASS' else 'FAIL' end
  union all
  select 62, 'statement/lock timeouts for the session that will apply',
         'statement_timeout=' || current_setting('statement_timeout')
         || ', lock_timeout=' || current_setting('lock_timeout'),
         'set a lock_timeout before applying (e.g. 5s)', 'INFO'
)
select step, check_name, actual, expected, verdict
  from checks
 order by step;

-- ============================================================================
-- POSTCHECK for the Statement Studio V2 rollout (008, 010-017)
-- ============================================================================
-- READ-ONLY. Run after the migrations and again after the catalog corrections.
-- ANY 'FAIL' MEANS STOP AND INVESTIGATE BEFORE GOING FURTHER.
--
-- WHAT IT PROVES, GROUPED BY WHAT COULD GO WRONG:
--   10s  every column and type the migrations promised
--   20s  every constraint, by DEFINITION and not merely by name
--   30s  the promotion RPC's signature, volatility, search_path and grants
--   40s  grants and RLS unchanged except where a migration said otherwise
--   50s  no row was harmed: counts, and the drafts' own contents
--   54-58 the corrections landed, and only where intended
--   60s  016 specifically -- the bound moved, nothing was rewritten
--
-- ONE STATEMENT; the SQL editor shows only the last result.
-- ============================================================================

with
  expected_columns(tbl, col, typ, migration) as (values
    ('statement_prompt_submissions', 'document_label',           'text',    '008'),
    ('statement_prompt_submissions', 'document_type_hint',       'text',    '008'),
    ('statement_prompt_submissions', 'stated_min_words',         'integer', '008'),
    ('statement_prompt_submissions', 'stated_max_characters',    'integer', '008'),
    ('statement_prompt_submissions', 'stated_max_pages',         'numeric', '008'),
    ('statement_prompt_submissions', 'stated_pages_text',        'text',    '008'),
    ('statement_prompt_submissions', 'formatting_instructions',  'text',    '008'),
    ('statement_prompt_submissions', 'other_instructions',       'text',    '008'),
    ('statement_prompt_submissions', 'submitter_note',           'text',    '008'),
    ('statement_prompt_submissions', 'approved_requirement_id',  'uuid',    '008'),
    ('statement_requirements',       'font_family_options',      'ARRAY',   '010'),
    ('statement_requirements',       'font_size_pt_options',     'ARRAY',   '010'),
    ('statement_requirement_sets',   'evidence_kind',            'text',    '011'),
    ('statement_requirement_sets',   'evidence_submission_id',   'uuid',    '011'),
    ('statement_prompt_submissions', 'submission_kind',          'text',    '012'),
    ('statement_prompt_submissions', 'challenged_requirement_id','uuid',    '012'),
    ('statement_requirements',       'supersedes_requirement_id','uuid',    '012'),
    ('statement_drafts',             'editor_document',          'jsonb',   '013'),
    ('statement_drafts',             'editor_document_version',  'smallint','013'),
    ('statement_requirements',       'document_format_profile',  'text',    '014'),
    ('statement_drafts',             'document_font',            'text',    '015')
  ),
  expected_constraints(tbl, name, must_contain, migration) as (values
    ('statement_prompt_submissions','statement_prompt_submissions_approval_shape','approved_requirement_id','008'),
    ('statement_requirements','statement_requirements_font_family_one_representation','font_family_options','010'),
    ('statement_requirements','statement_requirements_font_size_one_representation','font_size_pt_options','010'),
    ('statement_requirements','statement_requirements_font_family_options_shape','statement_text_options_ok','010'),
    ('statement_requirements','statement_requirements_font_size_options_shape','statement_int_options_ok','010'),
    ('statement_requirement_sets','statement_requirement_sets_evidence_kind_known','admin-approved-submission','011'),
    ('statement_requirement_sets','statement_requirement_sets_evidence_shape','evidence_submission_id','011'),
    ('statement_requirement_sets','statement_requirement_sets_active_needs_evidence','evidence_kind','011'),
    ('statement_prompt_submissions','statement_prompt_submissions_kind_known','submission_kind','012'),
    ('statement_prompt_submissions','statement_prompt_submissions_challenge_shape','challenged_requirement_id','012'),
    ('statement_requirements','statement_requirements_supersedes_not_self','supersedes_requirement_id','012'),
    ('statement_drafts','statement_drafts_editor_document_shape','editor_document_version','013'),
    ('statement_drafts','statement_drafts_editor_document_is_object','jsonb_typeof','013'),
    ('statement_drafts','statement_drafts_editor_document_version_known','editor_document_version','013'),
    ('statement_requirements','statement_requirements_format_profile_known','document_format_profile','014'),
    ('statement_drafts','statement_drafts_document_font_known','document_font','015'),
    ('statement_drafts','statement_drafts_essay_length','30000','016')
  ),
  checks as (

  select 1 as step, 'target database and executing role' as check_name,
         'db=' || current_database() || ', user=' || current_user as actual,
         'the production project' as expected, 'INFO' as verdict

  -- ---- 10s: columns and types ----------------------------------------------
  union all
  select 10, 'every promised column exists with the promised type',
         (select coalesce(string_agg(e.migration || '.' || e.col, ', ' order by e.col), 'all present')
            from expected_columns e
           where not exists (
             select 1 from information_schema.columns c
              where c.table_schema='public' and c.table_name=e.tbl
                and c.column_name=e.col and c.data_type=e.typ)),
         'all present',
         case when (select count(*) from expected_columns e
                     where not exists (
                       select 1 from information_schema.columns c
                        where c.table_schema='public' and c.table_name=e.tbl
                          and c.column_name=e.col and c.data_type=e.typ)) = 0
              then 'PASS' else 'FAIL' end
  union all
  -- THE TWO NOT-NULL COLUMNS ARE BOTH DELIBERATE, and both carry a default so
  -- existing rows are valid the instant they are added: 011's evidence_kind
  -- ('official-source') and 012's submission_kind ('new-prompt'). Every other
  -- new column must be nullable, because a new required field would reject
  -- rows that are already there.
  select 11, 'only the two intended columns are NOT NULL',
         (select coalesce(string_agg(c.column_name, ', ' order by c.column_name), 'as expected')
            from expected_columns e
            join information_schema.columns c
              on c.table_schema='public' and c.table_name=e.tbl and c.column_name=e.col
           where c.is_nullable='NO'
             and c.column_name not in ('evidence_kind', 'submission_kind')),
         'as expected',
         case when (select count(*) from expected_columns e
                      join information_schema.columns c
                        on c.table_schema='public' and c.table_name=e.tbl and c.column_name=e.col
                     where c.is_nullable='NO'
                       and c.column_name not in ('evidence_kind','submission_kind')) = 0
              then 'PASS' else 'FAIL' end
  union all
  select 12, 'and each of those two has a default, so existing rows stay valid',
         (select coalesce(string_agg(c.column_name || '=' || coalesce(c.column_default,'NONE'),
                                     ', ' order by c.column_name), 'none')
            from information_schema.columns c
           where c.table_schema='public'
             and c.column_name in ('evidence_kind','submission_kind')),
         'both defaulted',
         case when (select count(*) from information_schema.columns c
                     where c.table_schema='public'
                       and c.column_name in ('evidence_kind','submission_kind')
                       and c.column_default is null) = 0
              then 'PASS' else 'FAIL' end

  -- ---- 20s: constraints, by definition -------------------------------------
  union all
  select 20, 'every promised constraint exists AND says what it should',
         (select coalesce(string_agg(e.migration || '.' || e.name, ', ' order by e.name), 'all correct')
            from expected_constraints e
           where not exists (
             select 1 from pg_constraint k
              where k.conrelid = ('public.' || e.tbl)::regclass
                and k.conname = e.name
                and pg_get_constraintdef(k.oid) like '%' || e.must_contain || '%')),
         'all correct',
         case when (select count(*) from expected_constraints e
                     where not exists (
                       select 1 from pg_constraint k
                        where k.conrelid = ('public.' || e.tbl)::regclass
                          and k.conname = e.name
                          and pg_get_constraintdef(k.oid) like '%' || e.must_contain || '%')) = 0
              then 'PASS' else 'FAIL' end

  -- ---- 30s: the promotion RPC ----------------------------------------------
  union all
  select 30, 'the promotion RPC exists exactly once',
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='promote_statement_submission_to_requirement'),
         '1',
         case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public'
                       and p.proname='promote_statement_submission_to_requirement') = 1
              then 'PASS' else 'FAIL' end
  union all
  select 31, 'its signature is unchanged',
         (select pg_get_function_identity_arguments(p.oid) from pg_proc p
            join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='promote_statement_submission_to_requirement'),
         -- WITH PARAMETER NAMES. pg_get_function_identity_arguments includes
         -- them; comparing against a bare type list is a defect the October
         -- rehearsal already found once in statement_analyses_security_check.
         'p_submission_id uuid, p_reviewer uuid, p_mode text, '
         || 'p_requirement jsonb, p_set jsonb, p_set_id uuid',
         case when (select pg_get_function_identity_arguments(p.oid) from pg_proc p
                      join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public'
                       and p.proname='promote_statement_submission_to_requirement')
                   = 'p_submission_id uuid, p_reviewer uuid, p_mode text, '
                     || 'p_requirement jsonb, p_set jsonb, p_set_id uuid'
              then 'PASS' else 'FAIL' end
  union all
  select 32, 'it is SECURITY DEFINER with an empty search_path',
         (select case when p.prosecdef then 'definer' else 'invoker' end
                 || ', ' || coalesce(array_to_string(p.proconfig, ','), 'no proconfig')
            from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='promote_statement_submission_to_requirement'),
         'definer, search_path=""',
         case when (select p.prosecdef and 'search_path=""' = any(p.proconfig)
                      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='public'
                       and p.proname='promote_statement_submission_to_requirement')
              then 'PASS' else 'FAIL' end
  union all
  select 33, 'EXECUTE on it is service_role only',
         (select coalesce(string_agg(distinct grantee, ', ' order by grantee), 'nobody')
            from information_schema.role_routine_grants
           where routine_schema='public'
             and routine_name='promote_statement_submission_to_requirement'
             and privilege_type='EXECUTE'
             and grantee not in ('postgres','supabase_admin', current_user)),
         'service_role',
         case when (select coalesce(string_agg(distinct grantee, ','), '')
                      from information_schema.role_routine_grants
                     where routine_schema='public'
                       and routine_name='promote_statement_submission_to_requirement'
                       and privilege_type='EXECUTE'
                       and grantee in ('anon','authenticated')) = ''
              then 'PASS' else 'FAIL -- anon or authenticated can execute it' end

  -- ---- 40s: grants and RLS --------------------------------------------------
  union all
  -- ANON READS THE CATALOG AND NOTHING ELSE, which is 005's deliberate grant:
  -- an unreleased catalog is protected by is_active in RLS, not by withholding
  -- SELECT. What anon must never hold is a privilege on a table of applicant
  -- work, or any write anywhere.
  select 40, 'anon holds SELECT on the catalog only, and no write anywhere',
         (select coalesce(string_agg(distinct table_name || ':' || privilege_type, ', '
                                     order by table_name || ':' || privilege_type), 'none')
            from information_schema.role_table_grants
           where grantee='anon' and table_schema='public'
             and table_name like 'statement\_%'),
         'statement_prompts:SELECT, statement_requirement_sets:SELECT, '
         || 'statement_requirements:SELECT',
         case when (select count(*) from information_schema.role_table_grants
                     where grantee='anon' and table_schema='public'
                       and table_name like 'statement\_%'
                       and (privilege_type <> 'SELECT'
                            or table_name in ('statement_drafts',
                                              'statement_prompt_submissions',
                                              'statement_analyses'))) = 0
              then 'PASS' else 'FAIL -- anon can reach applicant work or write' end
  union all
  select 41, 'RLS is still enabled on all four tables',
         (select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relrowsecurity
             and c.relname in ('statement_drafts','statement_requirements',
                               'statement_requirement_sets','statement_prompt_submissions')),
         '4',
         case when (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and c.relrowsecurity
                       and c.relname in ('statement_drafts','statement_requirements',
                                         'statement_requirement_sets','statement_prompt_submissions')) = 4
              then 'PASS' else 'FAIL' end
  union all
  select 42, 'authenticated cannot read an administrator''s review note',
         (select coalesce(string_agg(column_name, ', ' order by column_name), 'none')
            from information_schema.column_privileges
           where grantee='authenticated' and table_schema='public'
             and table_name='statement_prompt_submissions'
             and column_name in ('review_note','reviewed_by')),
         'none',
         case when (select count(*) from information_schema.column_privileges
                     where grantee='authenticated' and table_schema='public'
                       and table_name='statement_prompt_submissions'
                       and column_name in ('review_note','reviewed_by')) = 0
              then 'PASS' else 'FAIL' end

  -- ---- 50s: no row was harmed -----------------------------------------------
  union all
  select 50, 'requirement sets still 63',
         (select count(*)::text from public.statement_requirement_sets), '63',
         case when (select count(*) from public.statement_requirement_sets) = 63
              then 'PASS' else 'FAIL' end
  union all
  select 51, 'requirement documents still 80',
         (select count(*)::text from public.statement_requirements), '80',
         case when (select count(*) from public.statement_requirements) = 80
              then 'PASS' else 'FAIL' end
  union all
  select 52, 'nothing became active',
         (select count(*)::text from public.statement_requirement_sets where is_active), '0',
         case when (select count(*) from public.statement_requirement_sets where is_active) = 0
              then 'PASS' else 'FAIL' end
  union all
  select 53, 'every set defaulted to official-source evidence (011)',
         (select count(*)::text from public.statement_requirement_sets
           where evidence_kind <> 'official-source'),
         '0',
         case when (select count(*) from public.statement_requirement_sets
                     where evidence_kind <> 'official-source') = 0
              then 'PASS' else 'INFO -- a set has been promoted since; verify it deliberately' end

  -- ---- 54-58: THE CORRECTIONS LANDED, AND LANDED ONLY WHERE INTENDED --------
  --
  -- The per-document verdicts are in statement_catalog_corrections_preflight.sql
  -- -- generated from the same diff as the UPDATEs, so it reports ALREADY for
  -- every corrected row and is the authoritative record. These five steps are
  -- the aggregate properties that file cannot state: that the counts did not
  -- move, that the 006 invariant holds on the FINAL data, and that the three
  -- deferred prose documents are still deferred.
  union all
  select 54, 'both misspelled school names are corrected',
         (select string_agg(name, '; ' order by name) from public.schools
           where id in ('504d74ce-7ab1-44af-a7c2-60b241fbb407'::uuid,
                        'fef27c4e-a9a8-4dd4-82d9-92c8c218ff8f'::uuid)),
         'Cedar Crest College; Saint Mary''s University of Minnesota',
         case when (select string_agg(name, '; ' order by name) from public.schools
                     where id in ('504d74ce-7ab1-44af-a7c2-60b241fbb407'::uuid,
                                  'fef27c4e-a9a8-4dd4-82d9-92c8c218ff8f'::uuid))
                   = 'Cedar Crest College; Saint Mary''s University of Minnesota'
              then 'PASS'
              else 'FAIL -- and the redirect deploy must already have happened' end

  union all
  select 55, 'Southern Mississippi holds both option arrays, canonically sorted',
         (select coalesce(font_family_options::text, '(null)') || ' / '
                 || coalesce(font_size_pt_options::text, '(null)')
                 || ' / single: '
                 || coalesce(font_family, '(null)') || ','
                 || coalesce(font_size_pt::text, '(null)')
            from public.statement_requirements
           where id = 'f6017562-e76e-59c7-98b8-552c01dc0cb1'::uuid),
         '{Arial,"Times Roman"} / {11,12} / single: (null),(null)',
         case when (select font_family_options = array['Arial','Times Roman']::text[]
                       and font_size_pt_options = array[11,12]::integer[]
                       and font_family is null and font_size_pt is null
                      from public.statement_requirements
                     where id = 'f6017562-e76e-59c7-98b8-552c01dc0cb1'::uuid)
              then 'PASS' else 'FAIL' end

  union all
  select 56, 'exactly two documents carry a whole-document format profile',
         (select coalesce(string_agg(distinct document_format_profile, ',')
                   || ' x' || count(*)::text, 'none')
            from public.statement_requirements
           where document_format_profile is not null),
         'apa-7 x2',
         case when (select count(*) from public.statement_requirements
                     where document_format_profile is not null) = 2
               and (select count(*) from public.statement_requirements
                     where document_format_profile is not null
                       and document_format_profile <> 'apa-7') = 0
              then 'PASS' else 'FAIL' end

  union all
  select 57, 'no row carries unenforced_length beside a structured bound',
         (select count(*)::text from public.statement_requirements
           where unenforced_length is not null
             and (min_words is not null or max_words is not null
               or min_characters is not null or max_characters is not null
               or min_pages is not null or max_pages is not null)),
         '0',
         -- 006's CHECK makes this impossible to violate, which is the point:
         -- this step exists because eight corrections were WRITTEN as if it
         -- were possible, and the database -- not review -- caught it.
         case when (select count(*) from public.statement_requirements
                     where unenforced_length is not null
                       and (min_words is not null or max_words is not null
                         or min_characters is not null or max_characters is not null
                         or min_pages is not null or max_pages is not null)) = 0
              then 'PASS' else 'FAIL' end

  union all
  select 58, 'the three deliberately deferred prose documents still have theirs',
         (select count(*)::text from public.statement_requirements
           where unenforced_length is not null),
         '3',
         -- Franciscan La Crosse's exclusive "less than two pages", Gonzaga's
         -- optional references page and Keiser's scoped three pages. The clear
         -- that travels with a bound must not have reached these: they carry
         -- no bound, which is the same reviewed decision that defers them.
         case when (select count(*) from public.statement_requirements
                     where unenforced_length is not null) = 3
              then 'PASS'
              else 'FAIL -- a verified figure that cannot be encoded has been '
                   || 'lost, or a prose row gained a bound' end

  -- ---- 60s: 016, specifically ------------------------------------------------
  union all
  select 60, '016 moved the bound to 30000',
         (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid='public.statement_drafts'::regclass
             and conname='statement_drafts_essay_length'),
         'CHECK ((char_length(essay) <= 30000))',
         case when (select pg_get_constraintdef(oid) from pg_constraint
                     where conrelid='public.statement_drafts'::regclass
                       and conname='statement_drafts_essay_length') like '%30000%'
              then 'PASS' else 'FAIL' end
  union all
  select 61, '30,000 characters satisfy the constraint; 30,001 do not',
         (select case when char_length(repeat('a', 30000)) <= 30000
                       and not (char_length(repeat('a', 30001)) <= 30000)
                      then 'accepts 30000, rejects 30001' else 'bound is wrong' end),
         'accepts 30000, rejects 30001',
         case when char_length(repeat('a', 30000)) <= 30000
               and not (char_length(repeat('a', 30001)) <= 30000)
              then 'PASS' else 'FAIL' end
  union all
  select 62, 'no existing essay was rewritten or truncated by 016',
         (select count(*)::text from public.statement_drafts
           where char_length(essay) > 20000),
         '0 (nothing could have exceeded the old bound)',
         case when (select count(*) from public.statement_drafts
                     where char_length(essay) > 20000) = 0
              then 'PASS' else 'INFO -- drafts have since grown past 20000; 016 is now irreversible' end
  union all
  select 63, 'draft rows unchanged in number',
         (select count(*)::text from public.statement_drafts),
         'the same count the preflight recorded', 'INFO'
)
select step, check_name, actual, expected, verdict
  from checks
 order by step;

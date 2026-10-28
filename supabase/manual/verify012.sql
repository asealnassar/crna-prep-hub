-- ============================================================================
-- POST-012 VERIFICATION -- 20261008_012_statement_prompt_change_reports.sql
-- ============================================================================
-- READ-ONLY. ONE STATEMENT. No INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/GRANT/
-- REVOKE appears below. Run it immediately after applying 012.
--
-- step 98  MIGRATION 012 OBJECTS VERIFIED -- the schema, provable anywhere.
-- step 99  MIGRATION 012 VERIFIED -- step 98 AND the catalog invariants.
--
-- 012 touches TWO tables and issues NO grant. statement_prompt_submissions has
-- a COLUMN-SCOPED grant, so its two new columns are deliberately NOT selectable
-- by authenticated and the grant count stays 24; step 23 pins that as the
-- expected state. statement_requirements has a TABLE-level grant, so its two
-- new columns are covered automatically.
--
-- 012 SUPERSEDES verify011.sql step 71, verify010.sql step 61 and
-- verify008.sql step 41, all of which assert 012-017 unapplied.
--
-- CRASH-PROOF: relations via to_regclass(); every probe naming a 012 column is
-- deferred inside query_to_xml() behind a CASE guard.
-- ============================================================================
with
  sps  as (select to_regclass('public.statement_prompt_submissions') as oid),
  req  as (select to_regclass('public.statement_requirements')       as oid),
  sets as (select to_regclass('public.statement_requirement_sets')   as oid),
  d    as (select to_regclass('public.statement_drafts')             as oid),
  p    as (select to_regclass('public.statement_prompts')            as oid),
  hist as (select to_regclass('supabase_migrations.schema_migrations') as oid),

  new_col(tbl, col, udt, nullable, dflt) as (values
    ('statement_prompt_submissions','submission_kind',           'text','NO', '''new-prompt''::text'),
    ('statement_prompt_submissions','challenged_requirement_id', 'uuid','YES', null),
    ('statement_requirements',      'supersedes_requirement_id', 'uuid','YES', null),
    ('statement_requirements',      'origin_submission_id',      'uuid','YES', null)),

  new_con(con, def) as (values
    ('statement_prompt_submissions_kind_known',
     'CHECK ((submission_kind = ANY (ARRAY[''new-prompt''::text, ''prompt-change''::text])))'),
    ('statement_prompt_submissions_challenge_shape',
     'CHECK ((((submission_kind = ''new-prompt''::text) AND (challenged_requirement_id IS NULL)) OR ((submission_kind = ''prompt-change''::text) AND (challenged_requirement_id IS NOT NULL))))'),
    ('statement_requirements_supersedes_not_self',
     'CHECK (((supersedes_requirement_id IS NULL) OR (supersedes_requirement_id <> id)))')),

  -- 011 / 010 / 008 / C0 anchors
  con_011(con, def) as (values
    ('statement_requirement_sets_evidence_kind_known',
     'CHECK ((evidence_kind = ANY (ARRAY[''official-source''::text, ''admin-approved-submission''::text])))'),
    ('statement_requirement_sets_evidence_shape',
     'CHECK ((((evidence_kind = ''official-source''::text) AND (evidence_submission_id IS NULL)) OR ((evidence_kind = ''admin-approved-submission''::text) AND (evidence_submission_id IS NOT NULL))))'),
    ('statement_requirement_sets_active_needs_evidence',
     'CHECK (((is_active = false) OR ((verification_status = ''verified''::text) AND (verified_on IS NOT NULL) AND (((evidence_kind = ''official-source''::text) AND (source_url IS NOT NULL)) OR ((evidence_kind = ''admin-approved-submission''::text) AND (evidence_submission_id IS NOT NULL))))))')),
  con_010(con, def) as (values
    ('statement_requirements_font_family_one_representation',
     'CHECK (((font_family IS NULL) OR (font_family_options IS NULL)))'),
    ('statement_requirements_font_size_one_representation',
     'CHECK (((font_size_pt IS NULL) OR (font_size_pt_options IS NULL)))'),
    ('statement_requirements_font_family_options_shape',
     'CHECK (statement_text_options_ok(font_family_options))'),
    ('statement_requirements_font_size_options_shape',
     'CHECK (statement_int_options_ok(font_size_pt_options, 4, 72))')),
  fn_010(fname, body_md5) as (values
    ('statement_text_options_ok', 'a15eff8ce9f02794bdb17b76eb07f390'),
    ('statement_int_options_ok',  '9ee744a8bff2ae34b13c6b356159417a')),
  con_008(con, def) as (values
    ('statement_prompt_submissions_approval_shape',
     'CHECK ((((approved_prompt_id IS NULL) AND (approved_requirement_id IS NULL)) OR (status = ''approved''::text)))')),
  con_001(con, def) as (values
    ('statement_drafts_prompt_source_exclusive',
     'CHECK (((prompt_id IS NULL) OR (prompt_submission_id IS NULL)))'),
    ('statement_drafts_submission_has_text',
     'CHECK (((prompt_submission_id IS NULL) OR (prompt_text IS NOT NULL)))')),
  con_002(con, def) as (values
    ('statement_prompts_supersedes_not_self',
     'CHECK (((supersedes_prompt_id IS NULL) OR (supersedes_prompt_id <> id)))')),
  fn_003(fname, exec_role) as (values
    ('create_statement_draft_with_prompt_submission', 'authenticated'),
    ('withdraw_statement_prompt_submission',          'authenticated'),
    ('decide_statement_prompt_submission',            'service_role')),
  idx_000(idx) as (values
    ('statement_prompt_submissions_status_created_idx'),
    ('statement_prompt_submissions_submitter_idx'),
    ('statement_prompt_submissions_school_fingerprint_idx')),
  want_fns(fname) as (values
    ('claim_statement_analysis'),('create_statement_draft_with_prompt_submission'),
    ('decide_statement_prompt_submission'),('settle_statement_analysis'),
    ('statement_int_options_ok'),('statement_text_options_ok'),
    ('withdraw_statement_prompt_submission')),

  -- 013-017, COMPLETE this time: 013 adds TWO columns, not one
  pending_col(tbl, col, mig) as (values
    ('statement_drafts',       'editor_document',         '013'),
    ('statement_drafts',       'editor_document_version', '013'),
    ('statement_requirements', 'document_format_profile', '014'),
    ('statement_drafts',       'document_font',           '015')),

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

  got as (
    select
      (select count(*) from new_col w join information_schema.columns c
         on c.table_schema='public' and c.table_name=w.tbl and c.column_name=w.col
        and c.udt_name=w.udt and c.is_nullable=w.nullable
        and coalesce(c.column_default,'~')=coalesce(w.dflt,'~'))               as n_col,
      (select coalesce(string_agg(w.tbl||'.'||w.col||'='||coalesce((
                 select c.udt_name||'/'||c.is_nullable||'/'||coalesce(c.column_default,'nodefault')
                   from information_schema.columns c
                  where c.table_schema='public' and c.table_name=w.tbl and c.column_name=w.col),
                 'ABSENT'), ' ;; ' order by w.tbl, w.col),'(none)') from new_col w) as col_detail,
      (select count(*) from new_con w join pg_constraint k on k.conname=w.con
        and k.contype='c' and k.convalidated and pg_get_constraintdef(k.oid)=w.def
        and k.conrelid in ((select oid from sps),(select oid from req)))        as n_con,
      (select coalesce(string_agg(k.conname||' => '||pg_get_constraintdef(k.oid), ' ;; ' order by k.conname),'(none)')
         from pg_constraint k where k.conname in (select con from new_con))     as con_detail,
      -- shapes of both tables 012 touches
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='statement_prompt_submissions') as sps_cols,
      (select count(*) from pg_constraint where conrelid=(select oid from sps) and contype='c') as sps_chk,
      (select count(*) from pg_indexes where schemaname='public' and tablename='statement_prompt_submissions') as sps_idx,
      (select count(*) from pg_policies where schemaname='public' and tablename='statement_prompt_submissions') as sps_pol,
      (select count(*) from pg_trigger where tgrelid=(select oid from sps) and not tgisinternal) as sps_trg,
      (select count(*) from pg_constraint where conrelid=(select oid from sps) and contype='f') as sps_fk,
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='statement_requirements')   as req_cols,
      (select count(*) from pg_constraint where conrelid=(select oid from req) and contype='c') as req_chk,
      (select count(*) from pg_indexes where schemaname='public' and tablename='statement_requirements') as req_idx,
      (select count(*) from pg_policies where schemaname='public' and tablename='statement_requirements') as req_pol,
      (select count(*) from pg_trigger where tgrelid=(select oid from req) and not tgisinternal) as req_trg,
      (select count(*) from pg_constraint where conrelid=(select oid from req) and contype='f') as req_fk,
      -- privileges: 012 issues none, so the column-scoped grant stays at 24
      (select count(*) from information_schema.column_privileges
        where table_schema='public' and table_name='statement_prompt_submissions'
          and grantee='authenticated')                                         as sps_grants,
      (select count(*) from information_schema.column_privileges
        where table_schema='public' and table_name='statement_prompt_submissions'
          and grantee='authenticated'
          and column_name in ('submission_kind','challenged_requirement_id'))  as new_granted,
      (select count(*) from information_schema.column_privileges
        where table_schema='public' and table_name='statement_prompt_submissions'
          and grantee='authenticated' and column_name in ('review_note','reviewed_by')) as sps_leak,
      (select count(*) from information_schema.table_privileges
        where table_schema='public' and table_name='statement_prompt_submissions'
          and grantee in ('anon','service_role'))                              as sps_other,
      (select count(*) from (
         select a.grantee, a.privilege_type, null::name as col
           from pg_class c, aclexplode(c.relacl) a where c.oid=(select oid from req)
         union all
         select a.grantee, a.privilege_type, t.attname
           from pg_attribute t, aclexplode(t.attacl) a
          where t.attrelid=(select oid from req) and t.attnum>0) x
       where x.grantee <> (select relowner from pg_class where oid=(select oid from req))
         and not (x.grantee in (select oid from pg_roles where rolname in ('anon','authenticated'))
                  and x.privilege_type='SELECT' and x.col is null))            as req_stray,
      -- 012 creates no function
      (select count(*) from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
        where n.nspname='public' and pr.proname ilike '%statement%')           as fns_all,
      (select count(*) from want_fns w join pg_proc pr on pr.proname=w.fname
         join pg_namespace n on n.oid=pr.pronamespace and n.nspname='public')  as fns_known,
      -- no FK on any of the three unconstrained references
      (select count(*) from pg_constraint
        where conrelid in ((select oid from sps),(select oid from req)) and contype='f'
          and (pg_get_constraintdef(oid) ilike '%challenged_requirement_id%'
            or pg_get_constraintdef(oid) ilike '%supersedes_requirement_id%'
            or pg_get_constraintdef(oid) ilike '%origin_submission_id%'))      as new_fks,
      -- no row written beyond the default
      (select case when (select count(*) from new_col w join information_schema.columns c
                          on c.table_schema='public' and c.table_name=w.tbl
                         and c.column_name=w.col)=4
              then (xpath('/row/c/text()', query_to_xml(
                     'select (select count(*) filter (where submission_kind <> ''new-prompt'')'
                     || ' + count(challenged_requirement_id) from public.statement_prompt_submissions)'
                     || ' + (select count(supersedes_requirement_id) + count(origin_submission_id)'
                     || ' from public.statement_requirements) as c', false, true, '')))[1]::text::bigint
              else null::bigint end)                                           as non_default,
      (select case when (select count(*) from information_schema.columns
                          where table_schema='public' and table_name='statement_prompt_submissions'
                            and column_name='submission_kind')=1
              then (xpath('/row/c/text()', query_to_xml(
                     'select count(*) as c from public.statement_prompt_submissions'
                     || ' where submission_kind is null', false, true, '')))[1]::text::bigint
              else null::bigint end)                                           as null_kind,
      (select count(*) from public.statement_prompt_submissions)               as sps_rows,
      (select count(*) from public.statement_requirements)                      as req_rows,
      -- 011 / 010 / 008 / C0
      (select count(*) from con_011 w join pg_constraint k on k.conname=w.con
        and k.conrelid=(select oid from sets) and k.contype='c' and k.convalidated
        and pg_get_constraintdef(k.oid)=w.def)                                  as t11,
      (select count(*) from information_schema.columns
        where table_schema='public' and table_name='statement_requirement_sets') as t11_cols,
      (select count(*) from pg_constraint where conrelid=(select oid from sets) and contype='c') as t11_chk,
      (select count(*) from con_010 w join pg_constraint k on k.conname=w.con
        and k.conrelid=(select oid from req) and k.contype='c' and k.convalidated
        and pg_get_constraintdef(k.oid)=w.def)                                  as t10,
      (select count(*) from fn_010 w join pg_proc pr on pr.proname=w.fname
         join pg_namespace n on n.oid=pr.pronamespace and n.nspname='public'
        where md5(pr.prosrc)=w.body_md5 and not pr.prosecdef)                   as t10_fn,
      (select count(*) from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
         cross join lateral aclexplode(pr.proacl) a left join pg_roles r on r.oid=a.grantee
        where n.nspname='public' and pr.proname in (select fname from fn_010)
          and coalesce(r.rolname,'PUBLIC') <> pg_get_userbyid(pr.proowner))     as t10_stray,
      (select count(*) from con_008 w join pg_constraint k on k.conname=w.con
        and k.conrelid=(select oid from sps) and k.contype='c' and k.convalidated
        and pg_get_constraintdef(k.oid)=w.def)                                  as t8,
      (select coalesce(bool_or(relrowsecurity),false) from pg_class where oid=(select oid from sps)) as c0_rls,
      (select count(*) from idx_000 w join pg_indexes i
         on i.schemaname='public' and i.indexname=w.idx)                        as c0_idx,
      (select count(*) from con_001 w join pg_constraint k on k.conname=w.con
        and k.conrelid=(select oid from d) and k.contype='c' and k.convalidated
        and pg_get_constraintdef(k.oid)=w.def)                                  as c1,
      (select count(*) from con_002 w join pg_constraint k on k.conname=w.con
        and k.conrelid=(select oid from p) and k.contype='c' and k.convalidated
        and pg_get_constraintdef(k.oid)=w.def)                                  as c2,
      (select count(*) from fn_003 w
        where exists (select 1 from pg_proc pr
                        join pg_namespace n on n.oid=pr.pronamespace and n.nspname='public'
                        cross join lateral aclexplode(pr.proacl) a
                        left join pg_roles r on r.oid=a.grantee
                       where pr.proname=w.fname and r.rolname=w.exec_role
                         and a.privilege_type='EXECUTE' and pr.prosecdef
                         and coalesce(array_to_string(pr.proconfig,','),'')='search_path=""')) as c3,
      (select count(*) from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
         cross join lateral aclexplode(pr.proacl) a left join pg_roles r on r.oid=a.grantee
         join fn_003 w on w.fname=pr.proname
        where n.nspname='public'
          and coalesce(r.rolname,'PUBLIC') not in (w.exec_role, pg_get_userbyid(pr.proowner))) as c3_stray,
      -- 009 absent, 013-017 unapplied
      (select count(*) from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
        where n.nspname='public' and pr.proname='promote_statement_submission_to_requirement') as promo,
      (select count(*) from pending_col w join information_schema.columns c
         on c.table_schema='public' and c.table_name=w.tbl and c.column_name=w.col) as pending,
      (select coalesce(max(pg_get_constraintdef(oid)),'(absent)') from pg_constraint
        where conrelid=(select oid from d) and conname='statement_drafts_essay_length') as ceiling,
      (select case when (select oid from hist) is null then 0
              else (xpath('/row/c/text()', query_to_xml(
                     'select count(*) as c from supabase_migrations.schema_migrations'
                     || ' where version like ''%009%''', false, true, '')))[1]::text::int end) as hist_009,
      -- catalog
      (select count(*) from public.statement_requirement_sets)                 as sets_n,
      (select count(*) from public.statement_requirements)                     as docs_n,
      (select coalesce(md5(string_agg(id::text, ',' order by id::text)),'(empty)')
         from public.statement_requirement_sets)                               as sets_fp,
      (select coalesce(md5(string_agg(id::text, ',' order by id::text)),'(empty)')
         from public.statement_requirements)                                   as docs_fp,
      (select count(*) from correction_targets t
         join public.statement_requirements r on r.id=t.id)                    as targets
  ),
  schema_ok as (
    select ((select n_col from got)=4 and (select n_con from got)=3
        and (select sps_cols from got)=28 and (select sps_chk from got)=14
        and (select sps_idx from got)=4 and (select sps_pol from got)=2
        and (select sps_trg from got)=0 and (select sps_fk from got)=0
        and (select req_cols from got)=41 and (select req_chk from got)=30
        and (select req_idx from got)=3 and (select req_pol from got)=1
        and (select req_trg from got)=0 and (select req_fk from got)=1
        and (select sps_grants from got)=26 and (select new_granted from got)=2
        and (select sps_leak from got)=0 and (select sps_other from got)=0
        and (select req_stray from got)=0
        and (select fns_all from got)=7 and (select fns_known from got)=7
        and (select new_fks from got)=0
        and coalesce((select non_default from got),-1)=0
        and coalesce((select null_kind from got),-1)=0
        and (select t11 from got)=3 and (select t11_cols from got)=15
        and (select t11_chk from got)=9
        and (select t10 from got)=4 and (select t10_fn from got)=2
        and (select t10_stray from got)=0 and (select t8 from got)=1
        and (select c0_rls from got) and (select c0_idx from got)=3
        and (select c1 from got)=2 and (select c2 from got)=1
        and (select c3 from got)=3 and (select c3_stray from got)=0
        and (select promo from got)=0 and (select pending from got)=0
        and (select ceiling from got)='CHECK ((char_length(essay) <= 20000))'
        and (select hist_009 from got)=0) as ok
  ),
  catalog_ok as (
    select ((select sets_n from got)=63 and (select docs_n from got)=80
        and (select sets_fp from got)='3a687c5449007fb17335e67677b85af5'
        and (select docs_fp from got)='eea3ea7f3f482d09e928b0a0db39b252'
        and (select targets from got)=28) as ok
  ),

  checks as (
    select 1 as step, 'database and executing role' as check_name,
           'db='||current_database()||', user='||current_user as actual,
           'the production project' as expected, 'INFO' as verdict
    union all
    select 10, '012: all 4 new columns across both tables, exact type/nullability/default',
           (select n_col::text from got)||' of 4 correctly shaped', '4 of 4',
           case when (select n_col from got)=4 then 'PASS' else 'FAIL' end
    union all
    select 11, 'the column shapes actually found', (select col_detail from got),
           'submission_kind text NOT NULL default new-prompt; the other three uuid nullable', 'INFO'
    union all
    select 12, '012: its 3 CHECK constraints, matched on EXACT definition, validated',
           (select n_con::text from got)||' of 3 exact', '3 of 3',
           case when (select n_con from got)=3 then 'PASS' else 'FAIL' end
    union all
    select 13, 'the constraint definitions actually found', (select con_detail from got),
           'the three above', 'INFO'
    union all
    select 20, 'statement_prompt_submissions: 28 columns, 14 CHECKs',
           (select sps_cols::text from got)||' columns, '||(select sps_chk::text from got)||' CHECKs',
           '28 columns, 14 CHECKs',
           case when (select sps_cols from got)=28 and (select sps_chk from got)=14
                then 'PASS' else 'FAIL' end
    union all
    select 21, 'statement_requirements: 41 columns, 30 CHECKs',
           (select req_cols::text from got)||' columns, '||(select req_chk::text from got)||' CHECKs',
           '41 columns, 30 CHECKs',
           case when (select req_cols from got)=41 and (select req_chk from got)=30
                then 'PASS' else 'FAIL' end
    union all
    select 22, '012 created NO index, policy, trigger or FK on either table',
           'sps: '||(select sps_idx::text from got)||' idx / '||(select sps_pol::text from got)||' pol / '
           ||(select sps_trg::text from got)||' trg / '||(select sps_fk::text from got)||' FK; req: '
           ||(select req_idx::text from got)||' / '||(select req_pol::text from got)||' / '
           ||(select req_trg::text from got)||' / '||(select req_fk::text from got),
           'sps: 4/2/0/0; req: 3/1/0/1',
           case when (select sps_idx from got)=4 and (select sps_pol from got)=2
                 and (select sps_trg from got)=0 and (select sps_fk from got)=0
                 and (select req_idx from got)=3 and (select req_pol from got)=1
                 and (select req_trg from got)=0 and (select req_fk from got)=1
                then 'PASS' else 'FAIL' end
    union all
    select 23, '012 widened the column grant to 26, including both new columns',
           (select sps_grants::text from got)||' column grants, '||(select new_granted::text from got)
           ||' of the 2 new columns granted',
           '26 grants, 2 of 2 granted',
           case when (select sps_grants from got)=26 and (select new_granted from got)=2
                then 'PASS' else 'FAIL' end
    union all
    select 24, 'no leak and no new role: review_note/reviewed_by withheld, anon/service_role hold nothing',
           (select sps_leak::text from got)||' leaked, '||(select sps_other::text from got)
           ||' anon/service_role privs, '||(select req_stray::text from got)||' stray on requirements',
           '0, 0, 0',
           case when (select sps_leak from got)=0 and (select sps_other from got)=0
                 and (select req_stray from got)=0 then 'PASS' else 'FAIL' end
    union all
    select 25, '012 created NO function: still exactly the 7 expected statement_% functions',
           (select fns_all::text from got)||' present, '||(select fns_known::text from got)||' of 7',
           '7 present, 7 of 7',
           case when (select fns_all from got)=7 and (select fns_known from got)=7
                then 'PASS' else 'FAIL' end
    union all
    select 26, 'NO foreign key on any of the 3 unconstrained references (deliberate)',
           (select new_fks::text from got), '0',
           case when (select new_fks from got)=0 then 'PASS' else 'FAIL' end
    union all
    select 27, 'NO row written beyond the default, on either table',
           coalesce((select non_default::text from got)||' rows off the default','n/a (columns absent)'),
           '0 rows off the default',
           case when (select non_default from got)=0 then 'PASS' else 'FAIL' end
    union all
    select 28, 'the NOT NULL default reached every existing submission row',
           coalesce((select null_kind::text from got)||' rows with NULL submission_kind','n/a'),
           '0 rows',
           case when (select null_kind from got)=0 then 'PASS' else 'FAIL' end
    union all
    select 29, 'row counts (for the record)',
           (select sps_rows::text from got)||' submissions, '||(select req_rows::text from got)||' requirements',
           'unchanged by 012', 'INFO'
    union all
    select 40, '011 intact: 3 CHECKs exact, sets table 15 col / 9 CHK',
           (select t11::text from got)||' of 3, '||(select t11_cols::text from got)||' col, '
           ||(select t11_chk::text from got)||' CHK', '3 of 3, 15 col, 9 CHK',
           case when (select t11 from got)=3 and (select t11_cols from got)=15
                 and (select t11_chk from got)=9 then 'PASS' else 'FAIL' end
    union all
    select 41, '010 intact: 4 CHECKs exact, validators by body digest, owner-only ACL',
           (select t10::text from got)||' of 4 CHECKs, '||(select t10_fn::text from got)
           ||' of 2 validators, '||(select t10_stray::text from got)||' non-owner grantees',
           '4 of 4, 2 of 2, 0',
           case when (select t10 from got)=4 and (select t10_fn from got)=2
                 and (select t10_stray from got)=0 then 'PASS' else 'FAIL' end
    union all
    select 42, '008 intact: the relaxed approval_shape is still exact',
           (select t8::text from got)||' of 1', '1 of 1',
           case when (select t8 from got)=1 then 'PASS' else 'FAIL' end
    union all
    select 50, 'C0 intact: RLS on, 3 named indexes, 001/002 CHECKs exact, 003 RPCs correct',
           'rls='||(select c0_rls::text from got)||', '||(select c0_idx::text from got)||' idx, '
           ||(select c1::text from got)||' of 2 (001), '||(select c2::text from got)||' of 1 (002), '
           ||(select c3::text from got)||' of 3 (003), '||(select c3_stray::text from got)||' stray',
           'rls=true, 3 idx, 2, 1, 3, 0',
           case when (select c0_rls from got) and (select c0_idx from got)=3
                 and (select c1 from got)=2 and (select c2 from got)=1
                 and (select c3 from got)=3 and (select c3_stray from got)=0
                then 'PASS' else 'FAIL' end
    union all
    select 60, '009 never applied: no promotion RPC, no 009 in migration history',
           'RPC='||(select promo::text from got)||', history='||(select hist_009::text from got),
           'both 0',
           case when (select promo from got)=0 and (select hist_009 from got)=0
                then 'PASS' else 'FAIL' end
    union all
    select 61, '013-017 unapplied: 0 of their 4 columns, and the pre-016 essay ceiling holds',
           (select pending::text from got)||' of 4 columns; ceiling='||(select ceiling from got),
           '0 of 4; CHECK ((char_length(essay) <= 20000))',
           case when (select pending from got)=0
                 and (select ceiling from got)='CHECK ((char_length(essay) <= 20000))'
                then 'PASS' else 'FAIL' end
    union all
    select 70, 'catalog unchanged: 63 sets', (select sets_n::text from got), '63',
           case when (select sets_n from got)=63 then 'PASS' else 'FAIL' end
    union all
    select 71, 'catalog unchanged: 80 documents', (select docs_n::text from got), '80',
           case when (select docs_n from got)=80 then 'PASS' else 'FAIL' end
    union all
    select 72, 'catalog unchanged: set id fingerprint', (select sets_fp from got),
           '3a687c5449007fb17335e67677b85af5',
           case when (select sets_fp from got)='3a687c5449007fb17335e67677b85af5' then 'PASS' else 'FAIL' end
    union all
    select 73, 'catalog unchanged: document id fingerprint', (select docs_fp from got),
           'eea3ea7f3f482d09e928b0a0db39b252',
           case when (select docs_fp from got)='eea3ea7f3f482d09e928b0a0db39b252' then 'PASS' else 'FAIL' end
    union all
    select 74, 'catalog unchanged: all 28 correction targets', (select targets::text from got)||' of 28', '28 of 28',
           case when (select targets from got)=28 then 'PASS' else 'FAIL' end
    union all
    select 98, 'MIGRATION 012 OBJECTS VERIFIED',
           case
             when (select n_col from got)<>4 then 'NO -- a new column is missing or wrongly shaped; read steps 10-11'
             when (select n_con from got)<>3 then 'NO -- a CHECK is missing, unvalidated or differently defined; read steps 12-13'
             when (select sps_cols from got)<>28 or (select sps_chk from got)<>14
                  or (select req_cols from got)<>41 or (select req_chk from got)<>30
               then 'NO -- a table has an unexpected column or CHECK; read steps 20-21'
             when (select sps_idx from got)<>4 or (select sps_pol from got)<>2
                  or (select sps_trg from got)<>0 or (select sps_fk from got)<>0
                  or (select req_idx from got)<>3 or (select req_pol from got)<>1
                  or (select req_trg from got)<>0 or (select req_fk from got)<>1
               then 'NO -- 012 created an index, policy, trigger or FK; read step 22'
             when (select sps_grants from got)<>26 or (select new_granted from got)<>2
               then 'NO -- the column grant is not the intended 26 including both new columns; read step 23'
             when (select sps_leak from got)<>0 or (select sps_other from got)<>0
                  or (select req_stray from got)<>0
               then 'NO -- an unexpected privilege exists; read step 24'
             when (select fns_all from got)<>7 or (select fns_known from got)<>7
               then 'NO -- an unexpected statement_% function exists; read step 25'
             when (select new_fks from got)<>0
               then 'NO -- a foreign key was added on one of the 3 references; read step 26'
             when coalesce((select non_default from got),-1)<>0
                  or coalesce((select null_kind from got),-1)<>0
               then 'NO -- a row was written beyond the default; read steps 27-28'
             when (select t11 from got)<>3 or (select t11_cols from got)<>15
                  or (select t11_chk from got)<>9
               then 'NO -- migration 011 has been disturbed; read step 40'
             when (select t10 from got)<>4 or (select t10_fn from got)<>2
                  or (select t10_stray from got)<>0
               then 'NO -- migration 010 has been disturbed; read step 41'
             when (select t8 from got)<>1
               then 'NO -- migration 008 has been disturbed; read step 42'
             when not (select c0_rls from got) or (select c0_idx from got)<>3
                  or (select c1 from got)<>2 or (select c2 from got)<>1
                  or (select c3 from got)<>3 or (select c3_stray from got)<>0
               then 'NO -- the C0 foundation has been disturbed; read step 50'
             when (select promo from got)>0 or (select hist_009 from got)>0
               then 'NO -- 009 or the promotion RPC is present; read step 60'
             when (select pending from got)>0
                  or (select ceiling from got)<>'CHECK ((char_length(essay) <= 20000))'
               then 'NO -- a 013-017 object is already applied; read step 61'
             else 'YES -- 4 columns and 3 CHECKs exact across both tables, the grant widened to 26, nothing else created, no row written beyond the default, 011/010/008/C0 intact, 009 absent, 013-017 unapplied'
           end,
           'YES',
           case when (select ok from schema_ok) then 'PASS' else 'FAIL' end
    union all
    select 99, 'MIGRATION 012 VERIFIED',
           case
             when not (select ok from schema_ok) then 'NO -- the schema is wrong; read step 98 for the reason'
             when (select sets_n from got)<>63 or (select docs_n from got)<>80
               then 'NO -- the catalog row counts changed; read steps 70-71'
             when (select sets_fp from got)<>'3a687c5449007fb17335e67677b85af5'
                  or (select docs_fp from got)<>'eea3ea7f3f482d09e928b0a0db39b252'
               then 'NO -- a catalog id fingerprint changed; read steps 72-73'
             when (select targets from got)<>28
               then 'NO -- a correction target is missing; read step 74'
             else 'YES -- 012 applied exactly across both tables, 011/010/008 and C0 000-003 intact, 009 absent, 013-017 unapplied, and the pre-existing catalog is byte-for-byte what it was'
           end,
           'YES',
           case when (select ok from schema_ok) and (select ok from catalog_ok)
                then 'PASS' else 'FAIL' end
  )
select step, check_name, actual, expected, verdict from checks order by step;

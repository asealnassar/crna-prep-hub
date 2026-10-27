-- Statement Studio V2 -- CATALOG IMPORT POSTCHECK.
-- READ-ONLY. Run AFTER statement_requirements_catalog_import.sql.
-- Mutates nothing.
--
-- GENERATED with the import it checks, from the same payload, so the
-- expected distributions below are not a human retyping a report.
--
-- IT COMPARES FINGERPRINTS, NOT JUST COUNTS. "63 sets exist" is satisfied by
-- 63 of the wrong sets. The md5 of the ordered id list is the payload
-- identity, so step 110 fails if a single row is the wrong row.
--
-- THIS IS ALSO THE QUERY TO RUN AFTER AN UNCERTAIN EXECUTION. Step 100
-- classifies the state in one number: 0 means definitely not applied, 143
-- means fully applied, anything else means STOP. See the import header and
-- the runbook.
--
-- READ STEP 100 BEFORE READING ANYTHING ELSE. Every check from 110 down
-- describes a catalog that HAS been imported. On an empty database they all
-- report FAIL, and that is the correct answer to the question they ask -- it
-- is not a malfunction and it is not a reason to import. If step 100 says
-- DEFINITELY NOT APPLIED, the eleven failures below say the same thing a
-- second time and carry no extra information.
--
-- SOURCE FINGERPRINTS (SHA-256). The reviewed files are the files executed:
--   06_IMPORT_programs.csv                       75ce2e3cec2989608fa0cbb4884bec64923cc96c5ba920ce3b7e3f94edc0bdd4
--   07_IMPORT_documents.csv                      9a4158a137f0183f088263bf0c87f7f54d9d149ce3f23e17be6d363841f9f476
--   10_school_id_reconciliation.csv              709b1203dfd7f216710cc0946aa6eca32f57b6c2a0eeb4cd53548f6f8a91a39b
--   11_statement_requirement_sets_preview.csv    aedb965ba83172329fe14e4a79322ac1adbcb9de4f5452b4e81b183c92fb8979
--   12_statement_requirements_preview.csv        10ba99d9c8c9c067dcba88677c4d83f88741c7fda7f08504aa6654cb7c8ac9e4
--   payload set fingerprint (md5 of ordered ids)       3a687c5449007fb17335e67677b85af5
--   payload document fingerprint (md5 of ordered ids)  eea3ea7f3f482d09e928b0a0db39b252
--
-- ONE STATEMENT. READ THE VERDICT COLUMN.

with
  payload_sets(id) as (values
  ('01898b8b-1205-5d14-abec-ff735176c47e'::uuid),
  ('02c09cfd-2151-58fb-9b46-3ea9632808bf'::uuid),
  ('031c35c4-5a64-57a4-ab92-910c7b135faa'::uuid),
  ('081ab7bf-8473-531b-aa37-059dfc776bd8'::uuid),
  ('0eb7cbe5-9a3f-5370-bb77-aae7bea52ef9'::uuid),
  ('12a60b38-6ac6-5b39-b48b-22661c388be4'::uuid),
  ('14ab34a4-1dd8-5e93-bfe6-8886945f06c8'::uuid),
  ('14c18c10-c00e-50d7-862a-e112de7b8f52'::uuid),
  ('1624c0fb-552f-5538-b6dd-35f35e961f1d'::uuid),
  ('1c7bf14f-28eb-57a2-a22d-b69bb9b913e8'::uuid),
  ('1d21512b-4ab6-54da-8196-8f5c51d62d25'::uuid),
  ('235262da-d2f0-5980-989e-822d384fb3b6'::uuid),
  ('291a4a79-8b47-543c-94a9-cbae3afbbb6d'::uuid),
  ('2a6ce281-45e6-5b90-888a-0404c57d02c6'::uuid),
  ('2d07e630-1e2a-521a-8334-2d1fd6b56f97'::uuid),
  ('2f3ddc30-b90e-5eac-b1c3-629d896b4977'::uuid),
  ('313e9301-0245-57df-86bc-18fb89ddcdc7'::uuid),
  ('33115e48-21f6-5844-8e67-2629bea79cdd'::uuid),
  ('4533e949-0618-522c-9ae6-44764eae5e3e'::uuid),
  ('4ab785bd-8e57-5a43-9798-adf1f5ecc85b'::uuid),
  ('4ad7bcb4-e405-53ac-b353-f9afc9a67011'::uuid),
  ('524b63fc-69fc-5d0c-845b-12d8629f00d5'::uuid),
  ('544aa482-d88f-597e-99f3-667728756753'::uuid),
  ('574fef07-3d2f-58ee-8a2a-b64f68dcfe1c'::uuid),
  ('57e220b7-352e-5fb2-9c60-a13dfeeb815e'::uuid),
  ('587238f4-54c9-55f9-b60a-c2933c5baef2'::uuid),
  ('5d16cc78-cfda-5c1c-9f8d-8266b6d4d1bb'::uuid),
  ('65852260-a8e5-5b81-82a6-43619def50bb'::uuid),
  ('65beed5f-3402-585c-8d17-72afb695d29e'::uuid),
  ('65ec5791-fcfe-52c6-87b4-48f575bb680e'::uuid),
  ('665231d6-e086-5050-b641-333dd24287bc'::uuid),
  ('6932385e-0822-52ad-b774-e450188c6b4c'::uuid),
  ('6d7fa319-b706-50ea-9f34-309ad39b802e'::uuid),
  ('6f0ba679-41b0-5114-b8e8-76a171735616'::uuid),
  ('7a54c014-84bf-5060-b3e0-bf9b26d91663'::uuid),
  ('7e5aa590-8df0-518d-bcfd-b98cfa7f21bc'::uuid),
  ('80cea664-ae13-544f-b49b-9ef6f23415e7'::uuid),
  ('8be943c1-870b-5651-9cd3-f072c40407f1'::uuid),
  ('94f2dae4-4f12-54b1-aecb-68405a7c5f00'::uuid),
  ('9b9390aa-f8d8-5ad4-84c7-7ebf9fc8bc43'::uuid),
  ('9c649b16-d703-5151-84e6-c2fe5a67f10b'::uuid),
  ('9c752371-5d30-5789-84a9-32b47d638495'::uuid),
  ('a2b120de-5b0b-54bb-a0d2-1095ce84f00c'::uuid),
  ('abbff745-ac83-5ce3-8b0d-96d7839f2890'::uuid),
  ('ac843de8-b7d1-5eed-b1b1-4cb5b3308d49'::uuid),
  ('ae1901b5-0cc9-5f33-bab7-9a9f2f3862eb'::uuid),
  ('b5d913ae-f3da-5823-9285-951cd82c892a'::uuid),
  ('b6e3cde7-ac51-53ee-be99-9090ae499598'::uuid),
  ('b7018ad2-cae8-5919-821b-63648ba6ccc8'::uuid),
  ('b9b7d288-e1e7-5609-aea4-1e9c2af22a68'::uuid),
  ('bc685c97-f9fd-553f-8e6e-2ae87de97632'::uuid),
  ('c22f1052-0b29-5d23-84b5-74615b2f9234'::uuid),
  ('c2d7974f-8a23-5f98-8129-e750ac5d632c'::uuid),
  ('cb55cf7d-83ed-5c2f-830f-c159585a06a6'::uuid),
  ('ce3d0c83-4a23-5261-8058-097968872dab'::uuid),
  ('dbf4fa7c-33b8-5b9f-899b-0bc4a3f292c9'::uuid),
  ('dcd90900-8db5-5b7f-ba01-28ab9823cd2e'::uuid),
  ('deef88ab-a1da-584a-957c-3be15f4fe303'::uuid),
  ('e4839445-65a2-53c2-b2c5-c124b17419af'::uuid),
  ('e54eecb8-a62d-51a3-9f4e-4d865989fba8'::uuid),
  ('e79a17f1-6440-55c7-9193-72fe3a9f58b7'::uuid),
  ('e9ca6462-5ca0-5020-aef9-d676720980ce'::uuid),
  ('f68f751e-a5dc-56f2-8fb4-a8590fe4d8a5'::uuid)),
  payload_docs(id) as (values
  ('01591a65-0626-55c4-993a-36143c825f9b'::uuid),
  ('036fe0f1-6562-553e-bd9d-db6de051c326'::uuid),
  ('041bcb8d-4207-584a-b860-b6168e696509'::uuid),
  ('04f95e0b-210f-5e95-b027-f1edfd9cc4cc'::uuid),
  ('080615bf-1370-5940-9edf-83c047fcc1cf'::uuid),
  ('0c7c760b-74f0-53bf-9d2f-469070d1186b'::uuid),
  ('0de844d7-97cb-58f5-90ee-e83675215cd6'::uuid),
  ('1040464f-8f46-5aae-87e5-38f1c128a5f8'::uuid),
  ('1076d245-2328-53ee-b5c9-d5d62d01a2e1'::uuid),
  ('10a0e18f-ae4b-5803-a718-788dea53404d'::uuid),
  ('18a8d96e-8b14-5c14-ae70-b279e3d2761d'::uuid),
  ('1f3ba87b-3c9f-5ec9-9b56-1d1b3ba60ee7'::uuid),
  ('1f74d500-7b24-56b0-a99f-fbd539c59240'::uuid),
  ('245c3d36-1be0-575c-97de-14fcdf289fb3'::uuid),
  ('24dd131c-da14-5735-a1d9-278f7348897f'::uuid),
  ('2b0cfefa-7892-520c-bfd0-84633346f71c'::uuid),
  ('2e8ad9b7-0d3a-5531-a8cd-5cd4a54456c8'::uuid),
  ('3107191b-4841-5113-b699-6279c0335c87'::uuid),
  ('3113b4d6-e0fe-5d21-850c-3c162bca70af'::uuid),
  ('32879ba3-43ce-5aeb-9c72-7fbfe05de9dd'::uuid),
  ('369eec21-84f6-5053-a953-8c224f6abc5d'::uuid),
  ('3908d30b-ab9a-597e-993e-b97b5dfbf62f'::uuid),
  ('4a06e99c-e525-5551-88f0-c43bd4e25dd5'::uuid),
  ('4a88f1fe-ffdb-58c3-9ba0-38dc93b77059'::uuid),
  ('4ebe0d1e-2918-5280-9d27-244f0fa52c1f'::uuid),
  ('4f4c6bc4-e491-5f8a-a635-73fbd4d1567f'::uuid),
  ('50ccd272-55ce-5a12-ba2b-4cd4a164d013'::uuid),
  ('5d04ab9e-571e-59c8-8cd7-a41488bfbaf2'::uuid),
  ('5dfd30d0-0fe8-585e-a2e0-7e45c88b2364'::uuid),
  ('60d171ce-c4d7-56b0-af06-22f5547cc37f'::uuid),
  ('639b5fc7-0889-5ab7-a7a4-a937a1a8358c'::uuid),
  ('64702cd6-235b-599c-9bdb-e70e526b9650'::uuid),
  ('673ed33c-039b-5298-a563-4e4538bffbaa'::uuid),
  ('6ceb21c7-0f90-526b-9dca-9d85d469b0cc'::uuid),
  ('6ea7a272-d705-56f2-9745-dbfdff27fec8'::uuid),
  ('79a3ae86-2111-5223-b64a-ee4084d90d38'::uuid),
  ('803ed8aa-d63e-529e-bcf0-68351ff22555'::uuid),
  ('82af2a6f-b690-58c9-9f6e-8c2ab5af79df'::uuid),
  ('830dfd41-3dd8-5309-baca-be6bb21dd655'::uuid),
  ('877e91e4-8c37-5d7b-b1a9-5876cb7755ce'::uuid),
  ('8a14bc2d-3ae8-5198-b837-24ae7ccaa963'::uuid),
  ('9184d807-6920-550e-9a4d-6230119397dd'::uuid),
  ('940dfa8f-2ba7-5d66-88a0-ed215ad74bbd'::uuid),
  ('95e62249-5e97-5415-b2cb-2571a2a1a709'::uuid),
  ('99672993-8d65-5b9c-832a-fe61f16174ba'::uuid),
  ('9d03d444-bdc1-57b4-9f54-aa7d91630e69'::uuid),
  ('a05ceaf6-106e-5d32-bb38-e83ff0e31824'::uuid),
  ('a614a9ef-f08c-5252-9072-db6ab78eb576'::uuid),
  ('a646e8e0-7212-510f-8c11-b85a32fc89a5'::uuid),
  ('a76e0da3-c8f7-544a-85de-c81125906659'::uuid),
  ('a8482c8f-c8dd-5150-8e9f-12fb3326db46'::uuid),
  ('ac89bef4-23f8-5305-95a0-46a3b16636e4'::uuid),
  ('afb0a6fb-9de8-52b0-be6a-8c51f8369834'::uuid),
  ('b717e3fd-d116-5fb7-b74b-0355a33cb143'::uuid),
  ('ba27174a-1bce-57df-a2f2-72eac697887e'::uuid),
  ('bb6fb9f2-d079-5f58-b083-4894b323c660'::uuid),
  ('bb79b81b-53d5-57b6-b890-d1b7c4c79cdc'::uuid),
  ('c1c80521-f07c-50e0-864c-08e7ca2c3a62'::uuid),
  ('c6466a7b-7d2b-5ec8-9970-de2bd772c020'::uuid),
  ('c855e881-1613-51c8-9ba8-cb46baa47399'::uuid),
  ('c8eb6be1-4704-570c-8af6-a8e7d45690c6'::uuid),
  ('caca81e1-ac0c-5142-9f0e-90d8c2383c30'::uuid),
  ('cafc159b-6981-5128-8350-6e5b8d7271c7'::uuid),
  ('cd158851-59b7-5c4d-befc-5e3acc9f79cf'::uuid),
  ('d3d09d1a-208b-50d8-93ed-38ccd0f97416'::uuid),
  ('d4e79cfc-8aa1-5c27-882b-3a9febbf3172'::uuid),
  ('d5e44837-33b5-5304-aeff-35ee7394d625'::uuid),
  ('d793a102-2684-536c-8a47-d7e8c8836d72'::uuid),
  ('da367d6c-9a8f-5407-96db-46ac901f7fe6'::uuid),
  ('da3a8f53-626c-5285-a0b8-03924181133e'::uuid),
  ('da7170ba-8229-59b1-bf52-8ee085621c2c'::uuid),
  ('dfd0cd87-ae77-5b75-8f94-986e60151ee8'::uuid),
  ('e2c8899b-52e7-5aac-bf14-2b3074383e2d'::uuid),
  ('e3ba199a-b767-5a60-a612-9f4152512625'::uuid),
  ('e3e6a2b1-98d2-5ea1-ab36-0612418c8b10'::uuid),
  ('e5bfc196-c427-5c47-b2ee-62d9e8fd1e19'::uuid),
  ('e7f63736-91f8-5fb9-a443-f8b5953ad4fe'::uuid),
  ('ec6ea75d-07fd-5cf2-a8dd-1f3ba37b6494'::uuid),
  ('ed3424a9-d410-54f9-b0a1-c929b07e75bd'::uuid),
  ('f6017562-e76e-59c7-98b8-552c01dc0cb1'::uuid)),
  held_back(school_id) as (values
  ('04aa37a5-084a-448e-91d5-25c38eb53c5d'::uuid),
  ('24556ebd-8926-4381-92f2-48db00a6884d'::uuid),
  ('2740f25b-588d-4e9e-950a-44de825b058d'::uuid),
  ('4f061e99-8077-42d8-91e2-5a4ba2c26d90'::uuid),
  ('51b9189c-f1a0-4733-955b-df1cb1967b8f'::uuid),
  ('534c5fef-4502-4e48-8bbf-676f93281eac'::uuid),
  ('6d69ab4e-c269-44e7-99de-648b266d6040'::uuid),
  ('89a1bb6e-f7dd-4437-a775-15128f926e53'::uuid),
  ('90653396-a0cc-4b59-ae26-945ea70649ef'::uuid),
  ('f21fc8b7-cc1d-496e-9739-9a28ea30b84c'::uuid)),
  exp_vstatus(k, n) as (values
  ('needs-review', 1),
  ('verified', 62)),
  exp_dtype(k, n) as (values
  ('additional-response', 14),
  ('autobiographical-essay', 1),
  ('goal-statement', 26),
  ('other', 2),
  ('personal-statement', 31),
  ('statement-of-purpose', 3),
  ('supplemental-essay', 1),
  ('writing-sample', 2)),
  exp_words(k, n) as (values
  (null, 53),
  ('enforced', 17),
  ('target', 10)),
  exp_chars(k, n) as (values
  (null, 79),
  ('enforced', 1)),
  exp_pages(k, n) as (values
  (null, 57),
  ('enforced', 22),
  ('truncated', 1)),
  checks as (

  select 100 as step,
         'STATE CLASSIFICATION  <<< read this first after any uncertain run' as check_name,
         (select count(*)::text from public.statement_requirement_sets
            where id in (select id from payload_sets))
           || ' of 63 sets + '
           || (select count(*)::text from public.statement_requirements
                where id in (select id from payload_docs))
           || ' of 80 documents' as actual,
         '63 + 80 = fully applied' as expected,
         case
           when (select count(*) from public.statement_requirement_sets
                   where id in (select id from payload_sets)) = 0
            and (select count(*) from public.statement_requirements
                   where id in (select id from payload_docs)) = 0
             then 'DEFINITELY NOT APPLIED -- none of the payload ids exist. This is the only state from which a fresh write may be considered.'
           when (select count(*) from public.statement_requirement_sets
                   where id in (select id from payload_sets)) = 63
            and (select count(*) from public.statement_requirements
                   where id in (select id from payload_docs)) = 80
             then 'PASS -- FULLY APPLIED. Do not rerun the import.'
           else 'FAIL -- UNEXPECTED/PARTIAL STATE. STOP. Do not rerun the import and do not delete anything. The import is one transaction, so a partial row count should be impossible; something else wrote to the catalog. Inspect before any action.'
         end as verdict

  union all
  select 101, 'no row outside the payload is in the catalog',
         (select count(*)::text from public.statement_requirement_sets
            where id not in (select id from payload_sets))
           || ' extra set(s), '
           || (select count(*)::text from public.statement_requirements
                where id not in (select id from payload_docs))
           || ' extra document(s)',
         '0 and 0',
         case when (select count(*) from public.statement_requirement_sets
                      where id not in (select id from payload_sets)) = 0
               and (select count(*) from public.statement_requirements
                      where id not in (select id from payload_docs)) = 0
              then 'PASS' else 'FAIL -- the catalog holds rows this import did not create' end

  union all
  select 110, 'SET FINGERPRINT (md5 of the ordered id list)',
         coalesce((select md5(string_agg(id::text, ',' order by id::text))
                     from public.statement_requirement_sets), '(empty)'),
         '3a687c5449007fb17335e67677b85af5',
         case when (select md5(string_agg(id::text, ',' order by id::text))
                      from public.statement_requirement_sets) = '3a687c5449007fb17335e67677b85af5'
              then 'PASS -- every set is the exact reviewed row, not merely 63 rows'
              else 'FAIL -- the set population differs from the reviewed payload' end

  union all
  select 111, 'DOCUMENT FINGERPRINT (md5 of the ordered id list)',
         coalesce((select md5(string_agg(id::text, ',' order by id::text))
                     from public.statement_requirements), '(empty)'),
         'eea3ea7f3f482d09e928b0a0db39b252',
         case when (select md5(string_agg(id::text, ',' order by id::text))
                      from public.statement_requirements) = 'eea3ea7f3f482d09e928b0a0db39b252'
              then 'PASS' else 'FAIL -- the document population differs' end

  union all
  select 200, 'every imported set is INACTIVE',
         (select count(*)::text from public.statement_requirement_sets where is_active),
         '0',
         case when (select count(*) from public.statement_requirement_sets
                      where is_active) = 0
              then 'PASS -- the catalog is invisible to applicants; activation is a separate decision'
              else 'FAIL -- a set is ACTIVE. The import does not activate; something else did.' end

  union all
  select 201, 'every document joins to exactly one imported set',
         (select count(*)::text from public.statement_requirements d
           where (select count(*) from public.statement_requirement_sets s
                   where s.id = d.set_id) <> 1),
         '0',
         case when (select count(*) from public.statement_requirements d
                      where (select count(*) from public.statement_requirement_sets s
                              where s.id = d.set_id) <> 1) = 0
              then 'PASS' else 'FAIL -- an orphaned or ambiguous document' end

  union all
  select 202, 'every document''s denormalised school_id matches its set',
         (select count(*)::text from public.statement_requirements d
            join public.statement_requirement_sets s on s.id = d.set_id
           where d.school_id <> s.school_id),
         '0',
         case when (select count(*) from public.statement_requirements d
                       join public.statement_requirement_sets s on s.id = d.set_id
                      where d.school_id <> s.school_id) = 0
              then 'PASS' else 'FAIL -- the picker query would read the wrong school' end

  union all
  select 203, 'every set has a source_url and a verified_on',
         (select count(*)::text from public.statement_requirement_sets
           where source_url is null or verified_on is null),
         '0',
         case when (select count(*) from public.statement_requirement_sets
                      where source_url is null or verified_on is null) = 0
              then 'PASS -- no verification metadata was fabricated and none is missing'
              else 'FAIL' end

  union all
  select 204, 'no HELD-BACK school reached the catalog',
         (select count(*)::text from public.statement_requirement_sets
           where school_id in (select school_id from held_back)),
         '0',
         case when (select count(*) from public.statement_requirement_sets
                      where school_id in (select school_id from held_back)) = 0
              then 'PASS' else 'FAIL -- a held-back programme is live in the catalog' end

  union all
  select 300, 'verification_status distribution is exact',
         coalesce((select string_agg(verification_status || '=' || c::text, ', ' order by verification_status)
                     from (select verification_status, count(*) c
                             from public.statement_requirement_sets group by 1) q), '(none)'),
         'needs-review=1, verified=62',
         case when not exists (
                select 1 from exp_vstatus e
                  full join (select verification_status k, count(*) n
                               from public.statement_requirement_sets group by 1) a
                         on a.k = e.k
                 where coalesce(a.n, -1) <> coalesce(e.n, -1))
              then 'PASS' else 'FAIL -- the status mix differs from the reviewed payload' end

  union all
  select 301, 'document_type distribution is exact',
         coalesce((select string_agg(document_type || '=' || c::text, ', ' order by document_type)
                     from (select document_type, count(*) c
                             from public.statement_requirements group by 1) q), '(none)'),
         'additional-response=14, autobiographical-essay=1, goal-statement=26, other=2, personal-statement=31, statement-of-purpose=3, supplemental-essay=1, writing-sample=2',
         case when not exists (
                select 1 from exp_dtype e
                  full join (select document_type k, count(*) n
                               from public.statement_requirements group by 1) a
                         on a.k = e.k
                 where coalesce(a.n, -1) <> coalesce(e.n, -1))
              then 'PASS -- including the three types migration 007 added' else 'FAIL' end

  union all
  select 310, 'word-enforcement distribution is exact',
         coalesce((select string_agg(coalesce(words_enforcement, '(null)') || '=' || c::text, ', '
                     order by coalesce(words_enforcement, '(null)'))
                     from (select words_enforcement, count(*) c
                             from public.statement_requirements group by 1) q), '(none)'),
         '(null)=53, enforced=17, target=10',
         case when not exists (
                select 1 from exp_words e
                  full join (select words_enforcement k, count(*) n
                               from public.statement_requirements group by 1) a
                         on coalesce(a.k, '') = coalesce(e.k, '')
                 where coalesce(a.n, -1) <> coalesce(e.n, -1))
              then 'PASS' else 'FAIL -- the word register mix differs from the reviewed payload' end

  union all
  select 311, 'character-enforcement distribution is exact',
         coalesce((select string_agg(coalesce(characters_enforcement, '(null)') || '=' || c::text, ', '
                     order by coalesce(characters_enforcement, '(null)'))
                     from (select characters_enforcement, count(*) c
                             from public.statement_requirements group by 1) q), '(none)'),
         '(null)=79, enforced=1',
         case when not exists (
                select 1 from exp_chars e
                  full join (select characters_enforcement k, count(*) n
                               from public.statement_requirements group by 1) a
                         on coalesce(a.k, '') = coalesce(e.k, '')
                 where coalesce(a.n, -1) <> coalesce(e.n, -1))
              then 'PASS' else 'FAIL -- the character register mix differs from the reviewed payload' end

  union all
  select 312, 'page-enforcement distribution is exact',
         coalesce((select string_agg(coalesce(pages_enforcement, '(null)') || '=' || c::text, ', '
                     order by coalesce(pages_enforcement, '(null)'))
                     from (select pages_enforcement, count(*) c
                             from public.statement_requirements group by 1) q), '(none)'),
         '(null)=57, enforced=22, truncated=1',
         case when not exists (
                select 1 from exp_pages e
                  full join (select pages_enforcement k, count(*) n
                               from public.statement_requirements group by 1) a
                         on coalesce(a.k, '') = coalesce(e.k, '')
                 where coalesce(a.n, -1) <> coalesce(e.n, -1))
              then 'PASS' else 'FAIL -- the page register mix differs from the reviewed payload' end

  union all
  select 320, 'fractional page limits present, and exactly as many as reviewed',
         (select count(*)::text from public.statement_requirements
           where max_pages is not null and max_pages <> trunc(max_pages)),
         '2',
         case when (select count(*) from public.statement_requirements
                      where max_pages is not null and max_pages <> trunc(max_pages)) = 2
              then 'PASS -- no page limit was rounded to an integer on the way in'
              else 'FAIL -- a fractional page limit was lost or invented' end

  union all
  select 321, 'Boston College: both goal essays carry max_pages = 1.5 exactly',
         coalesce((select string_agg(max_pages::text || '/' || coalesce(pages_enforcement, '(null)')
                                     || '/' || coalesce(page_spacing, '(null)'), ', ' order by id::text)
                     from public.statement_requirements
                    where id in ('d4e79cfc-8aa1-5c27-882b-3a9febbf3172'::uuid, '9d03d444-bdc1-57b4-9f54-aa7d91630e69'::uuid)), '(absent)'),
         '1.5/enforced/double, 1.5/enforced/double',
         case when (select count(*) from public.statement_requirements
                      where id in ('d4e79cfc-8aa1-5c27-882b-3a9febbf3172'::uuid, '9d03d444-bdc1-57b4-9f54-aa7d91630e69'::uuid)
                        and max_pages = 1.5 and pages_enforcement = 'enforced'
                        and page_spacing = 'double'
                        and min_pages is null
                        and max_words is null and max_characters is null) = 2
              then 'PASS -- 1.5 survived, and no word or character bound was derived from it'
              else 'FAIL' end

  union all
  select 330, 'Gonzaga: length stays PROSE ONLY, with no numeric bound',
         coalesce((select left(unenforced_length, 48) || ' | verbatim='
                     || coalesce(unenforced_length_verbatim::text, '(null)')
                     || ' | bounds=' || (case when coalesce(min_words, max_words,
                          min_characters, max_characters) is null
                          and min_pages is null and max_pages is null
                          then 'none' else 'PRESENT' end)
                     from public.statement_requirements where id = 'dfd0cd87-ae77-5b75-8f94-986e60151ee8'::uuid), '(absent)'),
         'the prose, verbatim=false, bounds=none',
         case when (select count(*) from public.statement_requirements
                      where id = 'dfd0cd87-ae77-5b75-8f94-986e60151ee8'::uuid
                        and unenforced_length is not null
                        and unenforced_length_verbatim = false
                        and min_words is null and max_words is null
                        and min_characters is null and max_characters is null
                        and min_pages is null and max_pages is null
                        and pages_enforcement is null) = 1
              then 'PASS -- the sentence is published and nothing is enforced'
              else 'FAIL -- a bound was invented, or the prose was lost' end

  union all
  select 331, 'UW-La Crosse: length stays PROSE ONLY, with no numeric bound',
         coalesce((select left(unenforced_length, 48) || ' | verbatim='
                     || coalesce(unenforced_length_verbatim::text, '(null)')
                     || ' | bounds=' || (case when coalesce(min_words, max_words,
                          min_characters, max_characters) is null
                          and min_pages is null and max_pages is null
                          then 'none' else 'PRESENT' end)
                     from public.statement_requirements where id = '82af2a6f-b690-58c9-9f6e-8c2ab5af79df'::uuid), '(absent)'),
         'the prose, verbatim=false, bounds=none',
         case when (select count(*) from public.statement_requirements
                      where id = '82af2a6f-b690-58c9-9f6e-8c2ab5af79df'::uuid
                        and unenforced_length is not null
                        and unenforced_length_verbatim = false
                        and min_words is null and max_words is null
                        and min_characters is null and max_characters is null
                        and min_pages is null and max_pages is null
                        and pages_enforcement is null) = 1
              then 'PASS -- the sentence is published and nothing is enforced'
              else 'FAIL -- a bound was invented, or the prose was lost' end

  union all
  select 400, 'grants unchanged: SELECT only to anon and authenticated',
         coalesce((select string_agg(table_name || '/' || grantee || '/' || privilege_type,
                                     '; ' order by table_name, grantee, privilege_type)
                     from information_schema.role_table_grants
                    where table_schema = 'public'
                      and table_name in ('statement_requirements','statement_requirement_sets')
                      and grantee in ('anon','authenticated','service_role')), 'none'),
         'SELECT only, on both tables',
         case when (select count(*) from information_schema.role_table_grants
                     where table_schema = 'public'
                       and table_name in ('statement_requirements','statement_requirement_sets')
                       and grantee in ('anon','authenticated','service_role')
                       and privilege_type <> 'SELECT') = 0
              then 'PASS -- a data import changes no grant' else 'FAIL' end

  union all
  select 401, 'RLS unchanged: enabled on both catalog tables',
         (select string_agg(relname || '=' || relrowsecurity::text, '; ' order by relname)
            from pg_class where relname in ('statement_requirements','statement_requirement_sets')
             and relnamespace = 'public'::regnamespace),
         'both true',
         case when (select count(*) from pg_class
                     where relname in ('statement_requirements','statement_requirement_sets')
                       and relnamespace = 'public'::regnamespace and relrowsecurity) = 2
              then 'PASS' else 'FAIL -- the catalog is readable without a policy' end

  union all
  select 402, 'policies unchanged: exactly the two 005 created',
         coalesce((select string_agg(tablename || '/' || policyname, '; ' order by tablename)
                     from pg_policies where schemaname = 'public'
                      and tablename in ('statement_requirements','statement_requirement_sets')), 'none'),
         'two SELECT policies',
         case when (select count(*) from pg_policies where schemaname = 'public'
                     and tablename in ('statement_requirements','statement_requirement_sets')) = 2
              then 'PASS' else 'FAIL' end

  union all
  select 500, 'neighbouring Statement Studio tables (COMPARE TO PREFLIGHT 700)',
         'drafts=' || (select count(*)::text from public.statement_drafts)
           || ' prompts=' || (select count(*)::text from public.statement_prompts)
           || ' analyses=' || (select count(*)::text from public.statement_analyses),
         'identical to preflight step 700',
         'INFO -- this import writes only the two catalog tables. A change here did not come from it.'

  union all
  select 600, 'rollout flags (NOT VISIBLE FROM SQL)',
         'check the deployment environment',
         'both still off',
         'INFO -- importing is not activating. Every set is is_active = false, so turning STATEMENT_REQUIREMENTS on would still show an applicant nothing.'
)
select step, check_name, actual, expected, verdict
from checks
order by step;

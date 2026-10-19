# Statement V2 — migration and catalog status

**This file is the authoritative record of what has been applied to
production.** Runbooks describe how to apply a thing; they are written before
it is applied and they do not get corrected afterwards, so a runbook's own
wording about state is historical and must not be read as current. Read this
file instead.

Last reviewed: 2026-10-15. Release-candidate freeze.

---

## 1. Exact production state

No summary here says "nothing applied", because that is not true and the
difference matters.

| thing | production |
| --- | --- |
| migrations **004 – 007** | **APPLIED** |
| the original **63-set / 80-document catalog import** | **APPLIED** |
| migration **008** | **NOT APPLIED** |
| migration **009** | **WITHDRAWN — NEVER APPLY** (deleted; see §3) |
| migrations **010 – 017** | **NOT APPLIED** |
| the **28-document normalization correction** | **NOT APPLIED** |
| the **Southern Mississippi** correction (the additional 29th document) | **NOT APPLIED** |
| the **two school-name corrections** | **NOT APPLIED** |
| **catalog activation** (`is_active`) | **NOT DONE** — all 63 sets inactive |
| the **Cedar Crest redirect implementation** | **LOCAL CODE — NOT DEPLOYED** |
| **all ten capability flags** (§6) | **NOT SET** anywhere |
| **AI analysis** | **intentionally 503** — `STATEMENT_ANALYSIS_CACHE` is off; see AI-QA-005 |

004 through 007 are applied. **007 is applied.** It is in the same uncommitted
state on this branch as 008 and 010–017, which is a fact about the branch and
not about the database: do not infer pending-ness from an untracked file.

## 2. Migrations

| migration | production | hard dependency |
| --- | --- | --- |
| `20261002_004_statement_analyses.sql` | **APPLIED** | — |
| `20261002_005_statement_requirements.sql` | **APPLIED** | — |
| `20261002_006_statement_requirement_length_register.sql` | **APPLIED** | 005 |
| `20261005_007_statement_requirement_document_types_and_pages.sql` | **APPLIED** | 005 |
| `20261006_008_statement_prompt_submission_requirement_fields.sql` | NOT APPLIED | none |
| `20261006_009_statement_submission_promotion.sql` | **WITHDRAWN — MUST NEVER BE APPLIED** | — |
| `20261008_010_statement_requirement_typography_options.sql` | NOT APPLIED | none |
| `20261008_011_statement_requirement_submission_evidence.sql` | NOT APPLIED | none |
| `20261008_012_statement_prompt_change_reports.sql` | NOT APPLIED | none |
| `20261011_013_statement_draft_editor_document.sql` | NOT APPLIED | none |
| `20261011_014_statement_document_format_profile.sql` | NOT APPLIED | none |
| `20261013_015_statement_draft_document_font.sql` | NOT APPLIED | none |
| `20261013_016_statement_draft_length_ceiling.sql` | NOT APPLIED | none |
| `20261015_017_statement_submission_promotion.sql` | NOT APPLIED — **replacement promotion migration** | **008 and 011** |

**The dependency column is measured, not read off the headers.** Each pending
file was applied on its own to a throwaway cluster holding exactly 004–007 plus
the baseline import. Eight of the nine succeeded alone; only 017 refused, and
it refused with its own message. Three headers claimed dependencies that did
not exist — 010, 011 and 012 each named 009 — and have been corrected.

## 3. 009 — WITHDRAWN, AND MUST NEVER BE APPLIED

`20261006_009_statement_submission_promotion.sql` **no longer exists in this
repository**, was never committed to git, and no database ever ran it.

It created the promotion RPC with an INSERT that named neither `evidence_kind`
nor `evidence_submission_id` — the columns 011 adds. A set published from an
applicant's submission would therefore have taken the column default and
recorded itself as an **official source**. Three consequences, in order:

1. the provenance is false — nobody checked the school's own page;
2. activation then fails, because 011's `active_needs_evidence` demands a
   `source_url` for official-source evidence and a submission-backed set has
   none to give honestly;
3. activated anyway, the Studio would tell the applicant "Confirmed against
   the school's published materials" — the defect QA-001 was raised for.

### Why it could not simply be fixed in place at 009

Because PostgreSQL would have allowed it, silently. `CREATE OR REPLACE
FUNCTION` checks a PL/pgSQL body for **syntax only** — it does not resolve
table or column references — so a 009 naming `evidence_kind` before 011 had
added it would have **applied cleanly** and then failed at the first promotion
with `column "evidence_kind" ... does not exist`. Verified on PostgreSQL 16.15
against a throwaway cluster; that experiment is why this is a withdrawal and
not an edit.

### Its replacement

**`20261015_017_statement_submission_promotion.sql`** — the same function, the
same signature, the same guards, the same two modes, the same `is_active =
false`, the same grants, **plus** the two evidence columns, **plus** a
precondition block that `raise exception`s unless 008 and 011 are both already
present. The order is enforced in SQL, not in documentation. Both refusals are
rehearsed: with 011 absent it refuses naming 011, with 011 present and 008
absent it refuses naming 008, and in neither case is the function created.

### How to tell whether it was ever applied

`statement_v2_rollout_preflight.sql` answers this in two ways and does not
trust either alone:

* **step 24 reads the schema**, which is authoritative. If the promotion
  function exists and its body does not mention `evidence_kind`, that is 009
  and the step FAILs with the remedy.
* **step 25 reads the CLI's migration history** if there is one, through
  `query_to_xml()` so that an absent history — the expected state, since these
  migrations are pasted into the SQL editor — does not break the script's
  parse. A recorded 009 FAILs, with a note that the resume series has its own
  unrelated `20260917_009`.

Nothing anywhere in this repository instructs an operator to apply 009.

## 4. Migration 016 — frozen at 30,000

| | |
| --- | --- |
| highest modeled current requirement demand | **24,000** stored characters |
| ceiling | **30,000** |
| headroom | **6,000** |

The binding figure is UT Knoxville's DNP Admission Essay: an 18,000-character
limit excluding spaces, which at pathologically short words is ~24,000 stored.
The next two are 3 pages (~13,680) and 1,000 words (~12,000). Re-derived over
all 56 bounded documents of the 79 served, after the normaliser fix, and
unchanged by it.

**Do not raise this again without re-running that derivation and finding a
school that needs it.** Every increase costs storage on `editor_document` as
well as `essay`, and an increase cannot be reverted once any applicant's draft
has grown past the old bound.

## 5. The catalog

The 63-set / 80-document import **has been applied to production**. All 63 sets
are `is_active = false`; no applicant is served any of them.

There are two versions of the import package and they are not interchangeable:

| | what it is | where |
| --- | --- | --- |
| **A. Production-applied baseline** | the exact content production holds | `supabase/manual/catalog_import_baseline/` |
| **B. Current normalized desired state** | A, plus the reviewed corrections | `supabase/manual/statement_requirements_catalog_import.sql` and siblings |

B is regenerated by `scripts/build_statement_requirements_import_sql.py` and
will be overwritten by the next run. A is frozen and is never generated.

Source fingerprint of the `12_statement_requirements_preview.csv` each was
built from — the only fingerprint that moves, because the set and document
fingerprints are identity hashes of the sorted ids and are **identical** in
both (`3a687c5449007fb17335e67677b85af5` / `eea3ea7f3f482d09e928b0a0db39b252`):

* A: `10ba99d9c8c9c067dcba88677c4d83f88741c7fda7f08504aa6654cb7c8ac9e4`
* B: `3fb63d8d58efd16aae6eb6d1340445570f85868bf96817f90666efcb53f301a6`

### Neither package may be rerun against production

**THE FULL IMPORT MUST NEVER BE RERUN.** The technical reason is not that it
would overwrite — it cannot.

Both packages are one transaction that stages into TEMP tables and then
requires an **empty** catalog. That precondition raises `IMPORT REFUSED …
NOTHING WAS INSERTED` before either statement that writes to `public`, and
neither file contains `ON CONFLICT`, `DELETE`, `TRUNCATE` or `UPDATE`
anywhere. Run today, either package refuses, inserts nothing and rolls back.

The rule stands for two different reasons:

1. **The import has no update path**, so it can never deliver a correction.
2. **Its refusal invites a destructive workaround** — emptying the tables or
   adding an upsert to make it "work" would discard activation state, admin
   catalog edits and promoted submissions.

**B's postcheck asserts the normalized state and would FAIL against production
today.** That is correct behaviour, not a bug: production has not been
corrected.

### How production reaches B

Three separate, targeted files. Each matches on a deterministic id **and** on
every value it expects to replace, so a row that has moved underneath it
matches nothing and reports REFUSED rather than overwriting work nobody
reviewed.

| file | what it touches | count | needs |
| --- | --- | --- | --- |
| `statement_catalog_corrections.sql` | `statement_requirements` | **28 documents**, 0 sets | 014 |
| `statement_southern_mississippi_typography_options.sql` | `statement_requirements` | **1 document** (the 29th) | 010 |
| `statement_school_name_corrections.sql` | `public.schools` | **2 rows** | — |

```
NORMALIZED CATALOG CORRECTION PACKAGE  statement_catalog_corrections.sql
  targeted set updates      : 0
  targeted document updates : 28
  prerequisite              : migration 20261011_014

SOUTHERN MISSISSIPPI TYPOGRAPHY-OPTIONS CORRECTION  separate file
  additional documents      : 1
  prerequisite              : migration 20261008_010

TOTAL TARGETED DOCUMENT OPERATIONS : 29
  ...of which the package above     : 28

SCHOOL-NAME CORRECTION  separate file
  rows                      : 2   on public.schools, NOT on the catalog
```

**28 and 29 are not interchangeable, and neither may be used for the other.**
The 28 is the normalization package. Southern Mississippi is an **additional**
document operation, in its own file, on its own prerequisite, and is **not part
of the 28-document normalization package.** The two school-name rows are not
document operations at all.

**Southern Mississippi is NOT one of the 28.** Its correction writes 010's
option columns, which are not part of the import payload at all, so it cannot
appear in a diff of that payload. It is a separate file and a 29th targeted
document update.

Per-document verdicts before applying come from
`statement_catalog_corrections_preflight.sql`, which is generated from the same
diff as the UPDATEs. The full manifest — id, school, document, columns, value
digests, reason and prerequisite — is `STATEMENT_CATALOG_CORRECTIONS.md`.

### The generator cannot produce an invalid row

Migration 006 forbids a row holding a structured bound **and**
`unenforced_length`. Eight desired documents used to hold both, which made
their UPDATEs impossible to apply — the database refuses them. The rule now
lives once, in `scripts/statement_catalog_invariants.py`, and all three
generators consume it: the normaliser clears prose a bound has superseded, and
the import builder and the correction builder each refuse to emit anything the
applied schema would reject. Mutation-tested in all three.

The three documents whose verified figures **cannot** be encoded keep their
prose, because the same reviewed decision gives them no bound: Franciscan La
Crosse's exclusive "less than two pages", Gonzaga's optional references page,
and Keiser's three pages excluding cover and references. No school is named in
the rule.

## 6. The capabilities, and what each one does

Ten flags. **Every one defaults to OFF in production**, and every one fails
closed: `env[NAME] === 'on'` and nothing else, so a typo, a blank value or an
absent variable is off. Nine are forced on when `NODE_ENV === 'development'`
and simulated-live is not opted out of, because the local JSON stores always
carry every column; `STATEMENT_ANALYSIS_CACHE` is the exception and is never
forced on anywhere.

**A FLAG IS NOT HOW A BAD MIGRATION IS DISCOVERED.** Every one of these is
enabled only after the database postcheck has passed — see §7. The flag's job
is to keep a column unread until the column exists and the code that reads it
is deployed; it is not a test of whether the migration was correct.

**TURNING ONE BACK OFF IS ALWAYS SAFE AND NEVER LOSES DATA.** The column keeps
whatever was written to it; the read stops asking for it. That is the whole
reason this is a read-side flag and not a write-side one.

| flag | prerequisite | while OFF | when ON | if turned off again |
| --- | --- | --- | --- | --- |
| `STATEMENT_REQUIREMENTS` | 005 (**applied**) | every requirement read returns `disabled`; the requirements endpoint answers `disabled`; a draft cannot be created against a requirement | structured requirement sets are read and served; the New Draft dialog can offer them | reads return `disabled` again; stored snapshots are untouched |
| `STATEMENT_TYPOGRAPHY_OPTIONS` | **010** | `font_family_options` / `font_size_pt_options` are not selected, so a permitted choice reads as no choice and the single required face still applies | a school that permits a choice of typeface or size has it offered | the arrays stay stored and stop being read |
| `STATEMENT_FORMAT_PROFILE` | **014** | `document_format_profile` is not selected, so a document reads as naming no standard — which is what every document was before 014 | a whole-document standard (`apa-7`) is applied | the column stays stored and stops being read |
| `STATEMENT_SUBMISSION_EVIDENCE` | **011** | `evidence_kind` / `evidence_submission_id` are not selected on a requirement **set** | a set published from an approved submission is distinguishable from an official source | the columns stay stored and stop being read |
| `STATEMENT_EDITOR_DOCUMENTS` | **013** | `editor_document` is neither read nor written; the editor is plain text; the AI-QA-001 `document-required` guard cannot fire, because no draft stores formatting | Bold is stored and restored, and an essay-only save of a formatted draft is refused rather than allowed to diverge | documents stay stored and stop being read; the guard goes quiet |
| `STATEMENT_DOCUMENT_FONT` | **015** | `document_font` is neither read nor written; every draft renders in the Studio default | the applicant's chosen face is stored and used for pagination | the choice stays stored and stops being read |
| `STATEMENT_PROMPT_SUBMISSIONS` | 20261002_000 (**applied**) | the submission endpoints answer `disabled`; the admin queue answers `disabled`; the Studio offers no submission | an applicant may submit a school prompt and an administrator may review it | the endpoints answer `disabled`; submitted rows are untouched |
| `STATEMENT_SUBMISSION_FIELDS` | **008** | 008's nine structured columns are not selected on a submission | a submission carries its label, document type and stated limits | the columns stay stored and stop being read |
| `STATEMENT_PROMPT_CHANGE_REPORTS` | **012** | 012's columns are not selected; a changed-prompt report cannot be filed, and replacement is refused with `needs-012` | an applicant may report that a school's prompt has changed, and a replacement can be linked | the columns stay stored and stop being read |
| `STATEMENT_ANALYSIS_CACHE` | 004 (**applied**) | **Analyze answers 503 for every caller** — `analysisAvailability()` returns `unavailable` outside development. This is **AI-QA-005**, and it is deliberate: without storage there is no deduplication, so every reopen would be another paid call, silently | the claim/settle machinery runs, an identical essay is answered from store with no model call, and two tabs cannot both pay | Analyze returns to 503; stored analyses are untouched and are read again when it is switched back on |

### Why the enable order is not the order these were written in

Three of these flags have **no reachable consumer** until
`STATEMENT_REQUIREMENTS` is on, and that is a fact about the code rather than a
preference:

* `requirementColumns()` is called only at `repo.ts:500` and `repo.ts:564`, and
  `setColumns()` only at `repo.ts:487` and `repo.ts:583`;
* every one of those sites is inside a function that returns
  `{ reason: 'disabled' }` at `repo.ts:481` or `repo.ts:558` when
  `requirementsEnabled()` is false.

So with `STATEMENT_REQUIREMENTS` off, switching on
`STATEMENT_TYPOGRAPHY_OPTIONS`, `STATEMENT_FORMAT_PROFILE` or
`STATEMENT_SUBMISSION_EVIDENCE` changes nothing observable and **cannot be smoke
tested** — there is no requirement read to widen. `STATEMENT_REQUIREMENTS`
therefore goes first, not last.

`STATEMENT_SUBMISSION_EVIDENCE` belongs with the requirement group for the same
kind of reason: despite its name it widens a requirement **set** projection
(`setColumns()`), not a submission one. Its only consumer is
`lib/statement/requirements/repo.ts:88`.

And `STATEMENT_PROMPT_SUBMISSIONS` leads its own group, because it gates the
endpoints (`app/api/statement/prompt-submissions/route.ts:53`,
`app/api/admin/statement-prompts/route.ts:55`) that the other two only add
columns to.

## 7. The exact rollout order

Seven stages. **Every write step needs the owner's explicit approval.** The
read-only stages may be run at any time and change nothing.

### Stage A — read-only preflight

Run `statement_v2_rollout_preflight.sql`.

Require **0 FAIL**: the 004–007 baseline present and unchanged, every pending
object absent, the catalog exactly 63/80 by fingerprint, nothing active, South
Dakota still `needs-review`, all 28 correction targets holding their expected
values, and steps 24–25 confirming 009 was never applied.

Any FAIL stops here. Nothing has been changed.

### Stage B — deploy the compatible code, every capability still OFF

Deploy the application with **all ten flags unset**.

**THIS DEPLOY MUST CARRY THE CEDAR CREST RETIRED-SLUG HANDLING.** See §8.

Safe because each new column is behind a flag that fails closed, so the build
asks for nothing the database does not yet have. Rollback is redeploying the
previous build.

### Stage C — schema, in this order

One documented path, spelled out. These are independently applicable — each was
rehearsed alone against a 004–007 cluster — but a single deterministic sequence
means one thing to follow and one thing to audit.

| order | migration | depends on | rollback | point of no return |
| --- | --- | --- | --- | --- |
| C1 | `20261006_008` | none | drop the nine columns | once a submission uses them |
| C2 | `20261008_010` | none | drop two columns + two validators | once a row stores an option array |
| C3 | `20261008_011` | none | restore 005's `active_needs_evidence`, drop two columns | once a set stores non-default evidence |
| C4 | `20261008_012` | none | drop four columns + three constraints | once a change report is filed |
| C5 | `20261011_013` | none | drop `editor_document` | once a draft stores one |
| C6 | `20261011_014` | none | drop `document_format_profile` | once a requirement stores one |
| C7 | `20261013_015` | none | drop `document_font` | once a draft stores one |
| C8 | `20261013_016` | none | **re-tighten the CHECK to 20,000** | **once any draft exceeds 20,000 characters — then it cannot be reverted** |
| C9 | `20261015_017` | **C1 (008) and C3 (011)** | `drop function` — it creates no data | once a submission is promoted |

**`20261006_009` IS WITHDRAWN AND IS NEVER APPLIED, at this stage or any
other.** It is absent from disk and from the whole of git history; see §3. C9
replaces it and refuses to install unless 008 and 011 are already present.

### Stage D — data corrections

First run `statement_catalog_corrections_preflight.sql` (needs C6). Require
every row **READY** and the summary **PROCEED**; a single **DRIFTED** stops the
stage.

Then, as three separate actions:

| order | correction | needs | rollback |
| --- | --- | --- | --- |
| D1 | `statement_catalog_corrections.sql` — **28 documents**, 0 sets | C6 (014), and D's preflight reading PROCEED | re-run with before/after swapped, from the manifest |
| D2 | `statement_southern_mississippi_typography_options.sql` — **1 document**, the 29th | C2 (010) | set both arrays null and restore the one `other_instructions` entry |
| D3 | `statement_school_name_corrections.sql` — **2 rows** on `public.schools` | **Stage B must already be deployed** — see §8 | re-run with the names swapped |

**28 and 29 are not interchangeable.** D1 is the normalization package; D2 is an
additional, separate document operation on its own prerequisite.

### Stage E — DATABASE POSTCHECK, before any capability is enabled

Run `statement_v2_rollout_postcheck.sql`. Require **0 FAIL**, and specifically:

* every promised column exists with the promised type;
* only the two intended columns are NOT NULL, and each has a default;
* every promised constraint exists **and says what it should**, by definition;
* the promotion RPC exists exactly once, with its unchanged signature, SECURITY
  DEFINER, an empty `search_path`, and EXECUTE granted to `service_role` only;
* that RPC is **evidence-aware** — its body writes `evidence_kind`, which is
  what distinguishes it from the withdrawn 009;
* `anon` holds SELECT on the catalog only and no write anywhere, and RLS is
  still enabled on all four tables;
* the catalog is still **63 sets / 80 documents**;
* **every set is still inactive**;
* the corrections are present — both school names, Southern Mississippi's two
  canonically sorted arrays, exactly two `apa-7` documents, no row carrying
  `unenforced_length` beside a bound, and the three deferred prose documents
  still carrying theirs;
* South Dakota is still `needs-review`;
* 016's bound is 30,000, 30,001 is refused, and no essay was rewritten.

**IF THIS FAILS, STOP WITH ALL TEN CAPABILITIES STILL OFF.** That is the whole
point of the ordering: a flag must never be the thing that discovers a bad
migration, because switching one on is what makes a wrong column reach an
applicant.

### Stage F — capability enablement, in groups, with a smoke check after each

Derived from the code, not from the order these were written; §6 explains why
`STATEMENT_REQUIREMENTS` leads and why the evidence flag sits with the
requirement group.

**ANY FAILING SMOKE CHECK: TURN THAT GROUP BACK OFF AND STOP.** Turning one off
never loses data.

| group | flags | smoke check |
| --- | --- | --- |
| **F1** | `STATEMENT_REQUIREMENTS` | the requirements endpoint answers instead of `disabled`; **and because every set is still inactive it exposes no catalog content publicly — verify that before going on** |
| **F2** | `STATEMENT_TYPOGRAPHY_OPTIONS`, `STATEMENT_FORMAT_PROFILE`, `STATEMENT_SUBMISSION_EVIDENCE` | Cedar Crest and New Mexico State read `apa-7`; Southern Mississippi offers both faces and both sizes with no single required value; Keiser still claims **no** profile; a set published from an approved submission reads as admin-approved rather than as an official source |
| **F3** | `STATEMENT_EDITOR_DOCUMENTS`, `STATEMENT_DOCUMENT_FONT` | plain text saves; Bold saves and survives reopen; a font choice saves and survives reopen; and none of the three moves the analysis fingerprint |
| **F4** | `STATEMENT_PROMPT_SUBMISSIONS` first, then `STATEMENT_SUBMISSION_FIELDS` and `STATEMENT_PROMPT_CHANGE_REPORTS` | a new prompt can be submitted, reviewed and promoted; a changed-prompt report can be filed and linked; replacement no longer refuses with `needs-012` |
| **F5** | `STATEMENT_ANALYSIS_CACHE` | **separate, and last.** This is the flag that turns Analyze from an intentional 503 into a working, billable feature — AI-QA-005. Enable only after Stage E passed and the deployed code is confirmed current. Then one controlled analysis on one draft: it validates, it is stored, an identical second request is a cache hit with no model call, and **no catalog set is activated to do it** |

### Stage G — catalog activation

**A completely separate, owner-approved action, and the last one.**
`is_active` must still be `false` for all 63 sets right up to this point.
Activation is **not** bundled with Stage F and must not be performed in the same
sitting without a fresh decision.

It is the only step an applicant can observe, and it is reversible by one
UPDATE.

## 8. The school-name correction, and the URL it moves

`/schools/{slug}` is derived from `schools.name` and is published in
`app/sitemap.ts`, so correcting a name **moves an indexed URL**.

* **Today** `/schools/ceder-crest` serves normally and must not redirect —
  verified in the browser against production data.
* **After D3** the old URL must answer a **permanent redirect (308)** to
  `/schools/cedar-crest-college`, which must itself serve and must not redirect
  again.
* **The sitemap must then publish only the new canonical URL.** It is built from
  `buildSlugMap` over the live directory and never consults the alias table, so
  it emits one address per school in both states.

> **STAGE B MUST BE DEPLOYED BEFORE D3.** The rename is applied in the SQL
> editor and the redirect ships in a build, so the two cannot be swapped
> together. Run the SQL first and `/schools/ceder-crest` 404s for every search
> result and saved link until the next deploy.

The alias is safe before, during and after, because it consults the live slug
map first and redirects only once the old slug is genuinely gone.

**Saint Mary's is a data correction with no slug move.** `slugifySchoolName`
strips apostrophes, so "Saint Marys University of Minnesota" and "Saint Mary's
University of Minnesota" both yield `saint-marys-university-of-minnesota`. It
needs no alias and deliberately has none.

## 9. Notes that outlive this rollout

**Numbering has not been reused.** 013, 014 and 015 are new numbers for new
work; nothing earlier was renumbered or rewritten to make room for them. 009 is
retired and its number is not reused either.

**015 and the bundled faces travel together.** Its CHECK lists the face ids the
Studio ships, and a face is added to it only in the same change that adds its
files — including its BOLD file, because Bold is available on every draft and a
browser left to invent one renders a page count that depends on the engine. A
test asserts the CHECK and `lib/statement/layout/studioFonts.ts` agree.

**Every pending column is reached only behind a rollout flag that fails
closed**, so an unapplied migration costs a feature and never a request: see
`lib/statement/draft/rollout.ts`. PostgREST answers a select naming an unknown
column with a 42703 for the **whole** query, which is why this is not optional.

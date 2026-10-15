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
| capability flags `STATEMENT_TYPOGRAPHY_OPTIONS`, `STATEMENT_FORMAT_PROFILE` | **NOT SET** anywhere |

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

## 6. The exact rollout order

Every step individually, with its direct dependency, its rollback and its
point of no return. **Nothing below has been done.**

| # | step | direct dependency | rollback | point of no return |
| --- | --- | --- | --- | --- |
| 1 | run `statement_v2_rollout_preflight.sql` | 004–007 applied | n/a — read-only | none |
| 2 | **deploy the application** (redirect code, capability flags unset) | step 1 all PASS | redeploy the previous build | none — the flags are off and every new column is behind one |
| 3 | apply `20261006_008` | none | drop the nine columns it adds | once an applicant submission uses them |
| 4 | apply `20261008_010` | none | drop two columns + two validator functions | once a row stores an option array |
| 5 | apply `20261008_011` | none | restore 005's `active_needs_evidence`, drop two columns | once a set stores non-default evidence |
| 6 | apply `20261008_012` | none | drop four columns + three constraints | once a change report is filed |
| 7 | apply `20261011_013` | none | drop `editor_document` | once a draft stores one |
| 8 | apply `20261011_014` | none | drop `document_format_profile` | once a requirement stores one |
| 9 | apply `20261013_015` | none | drop `document_font` | once a draft stores one |
| 10 | apply `20261013_016` | none | **re-tighten the CHECK to 20,000** | **once any draft exceeds 20,000 characters** — then it cannot be reverted |
| 11 | apply `20261015_017` | **008 (step 3) and 011 (step 5)** | `drop function` — it creates no data | once a submission is promoted |
| 12 | run `statement_catalog_corrections_preflight.sql` | step 8 (014) | n/a — read-only | none |
| 13 | apply `statement_catalog_corrections.sql` (28 documents) | step 12 reads **PROCEED** | re-run with before/after swapped, from the manifest | none — every UPDATE is reversible from the recorded old values |
| 14 | apply `statement_southern_mississippi_typography_options.sql` (29th) | step 4 (010) | set both arrays null and restore the one `other_instructions` entry | none |
| 15 | apply `statement_school_name_corrections.sql` (2 schools) | **step 2 must already be deployed** | re-run with the names swapped | **the indexed URL `/schools/ceder-crest` moves the moment this commits** |
| 16 | set `STATEMENT_TYPOGRAPHY_OPTIONS=on` | steps 4 and 14 | unset it | none — fails closed |
| 17 | set `STATEMENT_FORMAT_PROFILE=on` | steps 8 and 13 | unset it | none — fails closed |
| 18 | run `statement_v2_rollout_postcheck.sql` | all of the above | n/a — read-only | none |
| 19 | **catalog activation** — a separate, final, independent action | step 18, 0 FAIL | set `is_active = false` again | **the moment a set is active an applicant is served it** |

Steps 3–10 are independent of one another and may be applied in any order or
on separate days. Only **step 11 (017)** has a hard predecessor, and it
enforces it itself.

**Step 15 must not precede step 2.** The name correction is applied in the SQL
editor, not in a deploy, so there is no moment when the two can be swapped
together: the redirect must already be live when the name moves, or
`/schools/ceder-crest` 404s for every search result and saved link. The
redirect is safe before, during and after, because it consults the live slug
map first.

**Step 19 is the last thing, on its own.** It is the only step an applicant can
observe, and it is reversible by one UPDATE.

## 7. Notes that outlive this rollout

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

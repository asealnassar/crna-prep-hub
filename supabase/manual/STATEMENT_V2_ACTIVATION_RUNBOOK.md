# Statement Studio V2 — activation runbook

For `20261002_004_statement_analyses.sql`, `20261002_005_statement_requirements.sql`
and `20261002_006_statement_requirement_length_register.sql`.

> **STATE IS RECORDED ELSEWHERE — see `supabase/manual/MIGRATION_STATUS.md`.**
>
> This document was written before any of these ran and says they were
> unapplied. That was true then. **004, 005, 006 and 007 are now APPLIED to
> production**, as is the 63-set / 80-document catalog import.
>
> A runbook is a procedure, not a record: it is written in advance and is not
> revised each time something is applied, so nothing in it may be read as the
> current state of the database. Read MIGRATION_STATUS.md for that, and treat
> the steps below as the method only.

Nothing in this file has been executed. It is a procedure, not a record.

## Legend

Every step is tagged with what it costs:

| Tag | Meaning |
|---|---|
| 🔒 **LOCK** | Takes a lock that can make concurrent requests wait |
| 📡 **TRAFFIC** | Can be observed by, or affect, live users |
| 🔑 **CREDENTIALS** | Needs a secret, a signed-in session, or a service key |
| ✍️ **WRITES** | Changes data that survives the step |
| 👁 **READ-ONLY** | Mutates nothing |

Steps 1–2 and 4 and 6 are read-only. The first lock is step 3. The first thing
users can see is step 10.

---

## Step 0 — Backup and recovery prerequisites

🔑 **CREDENTIALS** (Supabase dashboard) · 👁 **READ-ONLY**

1. Confirm **Point-in-Time Recovery is enabled** on the project. If it is not,
   enabling it is a prerequisite, not an optional extra — see the rollback
   limitations at the end of this file for why.
2. Take a **manual backup** from the dashboard, or note that PITR covers you.
3. **Write down the UTC timestamp** immediately before step 3. That timestamp is
   the only true rollback point for a schema problem.
4. Note the project ref you are connected to, and confirm it is the one you mean.
   `lib/resume/migrate/target.ts` lists the production ref in
   `PRODUCTION_PROJECT_REFS`; this repository's only configured Supabase URL
   points there.

**Stop condition:** no PITR and no backup. Do not proceed.

---

## Step 1 — Read-only production preflight

👁 **READ-ONLY** · 🔑 **CREDENTIALS** (SQL editor)

Run, in order, and read the `verdict` column of each:

1. `supabase/manual/statement_requirements_preflight.sql`
2. `supabase/manual/statement_requirement_length_register_preflight.sql`
   — expect its steps 100–101 to **FAIL** at this point, because 005 has not run
   yet. That is correct: re-run it between steps 7 and 8.
3. `supabase/manual/statement_analyses_auth_users_reference_preflight.sql`
   — **this is the one that can stop step 3.** Its step 300 asks whether the
   role you are about to apply 004 as holds `REFERENCES` on `auth.users`.
   Migration 004 ends by adding a foreign key into Supabase's own schema, and
   that privilege is not something this project grants itself. Run it **as the
   same role that will apply 004** — a PASS obtained as another role, or as a
   superuser, says nothing about the role that does the work. Record steps 100
   and 203 (who you are, and who owns `auth.users`) with the rest.

**Record, verbatim, from the first file:**

- `statement_drafts` row count (step 300)
- `statement_prompts` row count and active count (steps 301, 302)
- `statement_drafts` grants (step 400)

Every postcheck compares against those four numbers. Without them, "nothing
changed" is an impression rather than a finding.

**Also confirm, in the deployment environment and not in SQL:**
`STATEMENT_ANALYSIS_CACHE`, `STATEMENT_REQUIREMENTS` and
`STATEMENT_PROMPT_SUBMISSIONS` are **unset**, or set to anything other than the
exact string `on`. All three fail closed on any other value.

**The flags stay off until both the migrations and the permission checks have
passed.** Not until the migrations apply — until step 4 and step 7 verify them
*and* step 1's `REFERENCES` check passed. A flag turned on beside a migration
that half-applied, or one applied by a role that could not complete it, is the
one combination in which applicants see errors rather than nothing.

**Stop condition:** any `FAIL` in the first file; any `FAIL` at step 300, 301,
400 or 402 of the third file; or any flag already `on`.

---

## Step 2 — Confirm the code deployed matches these migrations

👁 **READ-ONLY**

The application has to be the version that knows about these columns, or the
flags will expose a mismatch rather than a feature.

- `git log -1` on the deployed commit should be at or after the commit that
  carries `20261002_006`.
- `npm test` passes and `npx tsc --noEmit` is clean on that commit.
- `lib/statement/requirements/repo.ts` names the eight 006 columns in
  `REQUIREMENT_COLUMNS`. If the deployed build predates that, 006 is harmless
  but 005 plus the flag will not work as described here.

**Stop condition:** the deployed build does not contain the 006 columns in
`repo.ts`.

---

## Step 3 — Apply 004

🔒 **LOCK — `ShareRowExclusiveLock` on `auth.users`** · 📡 **TRAFFIC (signups)** ·
✍️ **WRITES** (schema) · 🔑 **CREDENTIALS**

Paste `supabase/migrations/20261002_004_statement_analyses.sql` whole into the
SQL editor. It is one `begin … commit`.

**Permission — check this before pasting.** Section 2b adds
`statement_analyses_user_fk`, a foreign key to `auth.users(id)`. PostgreSQL
requires `REFERENCES` privilege on the *referenced* table, and on Supabase
`auth.users` is owned by `supabase_auth_admin`, not by the role running the SQL
editor. `references auth.users(id)` is the standard documented Supabase pattern
and is expected to work — but if it is refused, **the whole migration rolls
back**, including the table, the policy and both functions created above it.
Step 1's third preflight answers this in one read-only query. Run it.

**Locks — this step no longer touches only new objects.** An earlier version of
this runbook said 004 takes no lock on anything users touch. That stopped being
true when the retention foreign keys were added, and the correction matters:

- Adding `statement_analyses_user_fk` takes **`ShareRowExclusiveLock` on
  `auth.users`**. Measured in the isolated local rehearsal: this **blocks
  inserts into `auth.users` — signups — while permitting reads**, so logins that
  only read are unaffected.
- `statement_analyses_draft_fk` takes the same lock on
  `public.statement_drafts`, blocking draft writes for the same window.
- In the SQL editor **the whole script is one transaction**, so both locks are
  held from their `alter table` statements until the script commits — not just
  for the statement itself.

**Do not infer the duration from the rehearsal.** The local measurement was
about 20 ms, but that was an empty table on an idle single-user cluster with no
pooler, no replication and no concurrent lock queue. It establishes *which*
locks are taken and *what they block*; it says nothing about how long production
will hold them or how deep a queue will form behind them. Apply during a quiet
period and watch the Supabase logs for lock waits rather than assuming
milliseconds.

**Rollback is clean.** `statement_analyses` is new and empty, so neither foreign
key has existing rows to validate — the work is a catalog change, not a scan.

**If it fails:** the transaction rolls back by itself and nothing partial
survives. Every statement is `if not exists` or `drop … if exists`, so re-running
after a fix is safe. Read the error before changing anything.

**Stop condition:** any error — in particular `permission denied for table
users`, which means the `REFERENCES` privilege is absent and step 1's third
preflight was skipped or ignored. Do not edit the migration in the editor to get
past it — fix the file in the repository, review the change, and start again.

---

## Step 4 — Verify the analysis-cache schema

👁 **READ-ONLY** · 🔑 **CREDENTIALS**

Run **Section A only** of
`supabase/manual/statement_analyses_security_check.sql`.

Expect every row `PASS`, except rows marked `INFO`.

Pay particular attention to:

- steps 601–603: `authenticated` must have **no** INSERT, UPDATE or DELETE;
- steps 611–614: `anon` must have **nothing**;
- steps 621–624: `service_role` must have **nothing** (it bypasses RLS);
- step 630 and 640: `PUBLIC` must hold nothing, and no grant may exist beyond
  `authenticated.SELECT`. A `FAIL` here is Supabase's schema **default
  privileges** surviving the migration's revoke, which is a known trap in this
  project — fix it with `alter default privileges`, not by editing the migration;
- steps 702 and 712: both functions must pin an **empty** `search_path`;
- steps 740 and 741: the deployed functions must contain the audit hardening
  (the draft-ownership read and the `on conflict` path). A `FAIL` means an older
  version of 004 was applied;
- steps 393–397: the two cascading foreign keys, the `claim_token` column, and
  that `settle_statement_analysis` takes **four** arguments with **one**
  overload. A `FAIL` on 397 means both the protected and the unprotected
  version exist and the unprotected one is still callable.

**Section A proves these objects exist as written. It does not prove access is
restricted at runtime** — it reads the catalog and never runs a query as `anon`
or as another applicant. Do not quote it as evidence of cross-user denial.

**Stop condition:** any `FAIL`. The table is inert at this point (no code names
it until step 9), so stopping here costs nothing.

---

## Step 5 — Apply 005

🔒 **LOCK — `ACCESS EXCLUSIVE` on `public.statement_drafts`** · 📡 **TRAFFIC** ·
✍️ **WRITES** (schema) · 🔑 **CREDENTIALS**

Paste `supabase/migrations/20261002_005_statement_requirements.sql` whole.

**This is the one step that locks a table users are using.** It adds two columns
to `statement_drafts` and four CHECK constraints. None of the CHECKs is declared
`NOT VALID`, so PostgreSQL **validates every existing row** while holding
`ACCESS EXCLUSIVE` — every draft read and every autosave waits for the duration.

At this table's size that is milliseconds. It is still a write lock on the table
holding applicants' work, so **run it during a quiet period**, and be aware that
an autosave in flight will block rather than fail.

The four CHECKs are expected to pass trivially: every existing row has both new
columns NULL, which satisfies all four. Step 1's preflight checked the same
predicates against today's data.

**If it fails:** it rolls back. The one failure mode worth naming is a CHECK
rejecting an existing draft — which should be impossible. **Do not weaken the
CHECK to get past it.** Capture the offending row and stop.

**Stop condition:** any error, or a lock that does not clear in seconds.

---

## Step 6 — Apply 006

🔒 **LOCK** (new table only) · ✍️ **WRITES** (schema) · 🔑 **CREDENTIALS**

First re-run `supabase/manual/statement_requirement_length_register_preflight.sql`
— now that 005 has landed, every step should `PASS`.

Then paste `supabase/migrations/20261002_006_statement_requirement_length_register.sql`
whole.

**Locks:** only `public.statement_requirements`, which 005 just created and which
has no rows and no readers. No traffic impact.

**Order is mandatory.** 006's CHECK constraints reference `min_words`,
`max_words`, `min_characters`, `max_characters`, `min_pages`, `max_pages` and
`page_spacing` — all created by 005. Applied first it fails.

**Stop condition:** any error, or any `FAIL` in the re-run preflight.

---

## Step 7 — Verify the requirement-catalog schema

👁 **READ-ONLY** · 🔑 **CREDENTIALS**

Run both:

1. `supabase/manual/statement_requirements_postcheck.sql`
2. `supabase/manual/statement_requirement_length_register_postcheck.sql`

Expect every row `PASS` except `INFO` rows.

**Compare against step 1's recorded numbers:**

| Postcheck step | Must equal |
|---|---|
| 900 | preflight 300 (`statement_drafts` count) |
| 904 | preflight 202 (prompt-backed drafts) |
| 905 | preflight 400 (`statement_drafts` grants) |
| 910, 911 | preflight 301, 302 (`statement_prompts` counts) |

**Any difference in 905, 910 or 911 is a finding, not a rounding error.** 005
names `statement_prompts` in no statement and adds no column-level grant, so
those three numbers cannot legitimately move.

Also confirm postcheck step 901: every existing draft still has
`requirement_id` NULL — nothing was retroactively given a requirement.

**Stop condition:** any `FAIL`, or any mismatch in the four comparisons.

---

## Step 8 — Behavioural verification · REQUIRES SEPARATE AUTHORIZATION

✍️ **WRITES** · 🔒 **LOCK** · 📡 **TRAFFIC** · 🔑 **CREDENTIALS**

**This step is not part of the activation and must be authorized on its own.**

Everything verified in steps 4 and 7 reads the catalog: it proves the policies,
grants and constraints *exist*. The guarantees this feature actually rests on —
RLS filtering, grants refusing, the CHECKs firing, the concurrency holding — are
behavioural.

**Those have now been executed against PostgreSQL, on a disposable local
cluster: 290 assertions, zero failures,** including both two-session concurrency
procedures and RLS from genuine `anon` and `authenticated` sessions. See
"Isolated environment" below for how to reproduce it and — more importantly —
for the list of what that run could *not* establish.

So the question for this step is no longer "do these behaviours work?" but
"do they work **on Supabase**?" What remains unverified there is narrow and
specific: GoTrue's real JWTs, PostgREST's role switching, Supabase's schema
default privileges, and `auth.users`' real ownership. Those are not things a
local cluster can speak to, and they are the reason this step still exists.

Four files cover the behaviour. The first two are safe to consider for
production with the cautions below; **the last two are local-only and will
refuse to run on a managed Supabase database:**

- `supabase/tests/statement_analyses_behaviour_test.sql`
- `supabase/tests/statement_requirements_behaviour_test.sql`
- `supabase/tests/statement_rls_role_session_test.sql` — local only; needs the
  scaffold, and connects *as* `anon` / `authenticated`, which Supabase does not
  permit. It also refuses an owner or superuser session on purpose.
- `supabase/tests/statement_analyses_concurrency_two_session.sh` — local only;
  commits writes, ages a row by eleven minutes, and requires a unix-socket
  connection so that it cannot reach a hosted database.

**Both WRITE.** They use synthetic ids and synthetic text, and they end in
`ROLLBACK` — and that is *not* the same as risk-free on production. Each takes
real locks (including on `statement_drafts`), consumes a pooler connection,
fires any trigger with an effect outside the database, and **commits everything**
if somebody runs the statements individually or never reaches the `ROLLBACK`.
Both insert into `auth.users`. Read each file's header in full before running it
anywhere.

**Neither can prove the three guarantees that need more than one session:**

- *Concurrency.* Two statements in one session are sequential. The two-session
  procedure is in the analyses test's header and needs two authenticated
  sessions, which means two JWTs.
- *RLS visibility and write refusal.* This session is the table owner, for whom
  RLS is not enforced. The non-owner procedure is in the requirements test's
  header; steps 1 and 3 of it **commit real catalog rows** and step 6 deletes
  them, which is a production data change.
- *The superseded request.* That an abandoned request cannot complete or release
  the claim that replaced it is the reason `claim_token` exists. The analyses
  test exercises the predicates in one session; the interleaving needs the
  second procedure in its header, which includes one write to force staleness
  rather than waiting eleven real minutes.

Section B of `statement_analyses_security_check.sql` lists the seven
authenticated-session checks (B1–B7) that need real JWTs. B4 — that an applicant
cannot write `statement_analyses` directly — is the one that matters most: it is
the difference between feedback that was generated and paid for, and feedback an
applicant typed.

**Recommended:** run all of this on an isolated project. See "Isolated
environment" below — one does not exist today and creating one is an option, not
a prerequisite.

**Stop condition:** any `FAIL` notice. Do not set a flag with a failing
behavioural check outstanding.

---

## Step 9 — Activate `STATEMENT_ANALYSIS_CACHE`

🔑 **CREDENTIALS** (deployment environment) · 📡 **TRAFFIC**

Set `STATEMENT_ANALYSIS_CACHE=on` and restart. Nothing else.

The exact string `on`. Anything else — `true`, `1`, `ON`, a trailing space — is
off, by design.

**What changes for users:** the analyser starts storing results and reusing
them. Before this, every request was a fresh model call; after it, an unchanged
draft re-analysed returns the stored result with no charge. Ultimate accounts
only; the tier gate is unchanged.

**Verify immediately:**

1. Open an existing draft. It must load and save exactly as before.
2. As an Ultimate account, analyse a draft. A row must appear in
   `statement_analyses` with `status = 'complete'`.
3. Re-run without editing. The response must be `cached: true`, with **no new
   ledger entry** in the usage table and no second model call.

**Rollback:** clear the variable and restart. No code change, no data loss; the
stored rows are simply not consulted.

**Stop condition:** drafts fail to load, or step 3 charges twice. Clear the flag.

---

## Step 10 — Activate `STATEMENT_REQUIREMENTS`

🔑 **CREDENTIALS** (deployment environment) · 📡 **TRAFFIC**

Only after step 9 is healthy. Set `STATEMENT_REQUIREMENTS=on` and restart.

**Leave `STATEMENT_PROMPT_SUBMISSIONS` alone at this step** — but note that
its migrations are no longer out of scope. This runbook used to call
`20261002_000..003` "a separate decision … not part of this activation", and
that sentence was the twin of the §6 cell in MIGRATION_STATUS.md that wrongly
recorded 000 as applied. The production Stage A reconciliation on 2026-10-22
found the series had **never been applied**, and it is now **Stage C0** of the
controlled rollout — required before 008, 012 and 017, and before this flag can
be enabled at all. See MIGRATION_STATUS.md §3a and Stage C0.

**What changes for users:** the draft `SELECT` begins naming `requirement_id`
and `requirement_snapshot`, and the New Draft flow begins offering
school-requirement sets. With zero rows in the catalog it finds none and falls
back to the single-prompt path — so the visible change at this moment should be
**none**.

**Verify immediately:**

1. The library lists drafts. If every draft read fails, the deployed build or the
   migrations do not match — clear the flag at once.
2. Create a general statement with no school. It must work.
3. Create a draft against the **Arkansas State** `statement_prompts` row. It must
   still behave as a legacy prompt draft: `prompt_id` set, `requirement_id` NULL.
4. The legacy Personal Statement Analyzer page is unchanged.

**Rollback:** clear the variable and restart.

**Stop condition:** anything in 1–4. Clear the flag.

---

## Step 11 — One controlled school-requirement test

✍️ **WRITES** (real catalog rows) · 🔑 **CREDENTIALS** · 📡 **TRAFFIC**

**One requirement. Not the 83-row research dataset.**

In the **SQL editor**, not through any application path — an applicant holds
table-level UPDATE on their own draft row, so the catalog must be populated by an
operator, and this test should exercise the same route an import would.

Use a real `public.schools` id and one verified entry from the research record:
either an Option A entry (length shown, no bound) or the UT Knoxville
character-limit entry.

**Insert the set INACTIVE first, then activate it in a separate statement.** You
should watch the database refuse an activation that lacks evidence:

1. Insert the set with `verification_status = 'unverified'`, `is_active = false`.
2. Try `update … set is_active = true`. **It must be refused** by
   `statement_requirement_sets_active_needs_evidence`. If it succeeds, stop — that
   constraint is the database-level half of the forged-requirement defence and
   has never been executed before this moment.
3. Set `verification_status = 'verified'`, a real `source_url`, a real
   `verified_on`, then activate. It must now succeed.
4. Insert one document under the set.

Then, signed in as the admin, **create one draft against it** through the New
Draft flow and confirm:

- `requirement_id` and `requirement_snapshot` are populated;
- `prompt_id` is NULL (the one-prompt-source CHECK);
- the editor shows the requirement's limits **in the school's own units** — no
  page count converted to words;
- for an Option A entry, the length appears as the school's quoted sentence with
  "not enforced here", and the word counter shows **no quota**.

**Rollback:** `delete from public.statement_requirement_sets where id = …` —
which cascades to the document. **The draft survives**, with its snapshot intact
and no requirement to resolve, which is the intended behaviour. Delete the draft
separately if you want a clean slate.

**Stop condition:** step 2 succeeding, or any limit displayed in a unit the
school did not use.

---

## Step 12 — Ultimate analysis and duplicate-call testing

✍️ **WRITES** · 🔑 **CREDENTIALS** (Ultimate account) · 📡 **TRAFFIC** ·
💵 **costs a model call**

As an Ultimate account, against the draft from step 11:

1. **Analyse.** Expect a row in `statement_analyses` with `status = 'complete'`
   and `provenance = 'catalog'` — `'catalog'` is the server establishing that the
   snapshot matches the catalog, and it is the thing to check.
2. **Re-run unchanged.** Expect `cached: true`, no new row, no new ledger entry,
   no model call.
3. **Edit one word and re-run.** Expect a new fingerprint, a new row, and exactly
   one new charge.
4. **Two tabs, Analyze in both at once.** Expect one result and either an
   "already running" response or a 503, and in **either case exactly one** paid
   call. Confirm with `select count(*) from public.statement_analyses where
   draft_id = …` — expect the number of distinct fingerprints, not more.
5. **Tamper, then analyse.** `PATCH` the draft's `requirement_snapshot` over
   PostgREST as that user — change a word of the stored prompt — and analyse
   again. Expect `provenance` to come back as `'user'`, not `'catalog'`: the
   server compares the whole snapshot against a catalog reconstruction and
   refuses to vouch for a changed one. This is the only check of that defence
   that exercises it end to end.
6. **Delete the draft.** Then
   `select count(*) from public.statement_analyses where draft_id = '<the draft>'`
   — expect **0**. The cascading foreign key is the whole retention mechanism;
   there is no sweep behind it, so if this returns a row, analyses quoting a
   deleted essay are accumulating and nothing else will notice.

**Stop condition:** step 2 charging, step 4 charging twice, step 5 still
reporting `'catalog'`, or step 6 returning anything but 0.

---

## Step 13 — Free and Premium authorization testing

🔑 **CREDENTIALS** (Free and Premium accounts) · 📡 **TRAFFIC** · 👁 no writes
expected

With both flags on, as a **Free** account and then a **Premium** account, POST
the analyse endpoint directly (not through the button — a hidden button is a
courtesy, the server is the control).

Expect, for both:

- HTTP **403** with code `analysis-requires-ultimate`;
- **no** new row in `statement_analyses`;
- **no** new entry in the usage ledger.

The tier gate sits at `app/api/statement/drafts/[id]/analyze/route.ts:175`, ahead
of the claim (line 334) and ahead of `recordStatementAttempt` (line 405), so a
refusal costs nothing. Confirm the two counts did not move.

**Stop condition:** a 200, or any row written. Clear
`STATEMENT_ANALYSIS_CACHE`.

---

## Catalog import — and what to do when the run is uncertain

✍️ **WRITES** (143 catalog rows) · 🔒 **LOCK** (the two catalog tables only) ·
🔑 **CREDENTIALS** · 👁 no traffic effect

The package is three generated files in `supabase/manual/`:

| File | |
|---|---|
| `statement_requirements_catalog_import_preflight.sql` | read-only, run first |
| `statement_requirements_catalog_import.sql` | the only writer |
| `statement_requirements_catalog_import_postcheck.sql` | read-only, run after |

All three are generated by `scripts/build_statement_requirements_import_sql.py`
from the validated dry-run previews and carry the SHA-256 of every source they
were built from, so the reviewed files can be proven to be the files executed.
**Do not hand-edit them — rebuild them.**

**It imports 63 sets and 80 documents, every set `is_active = false`.** Importing
is not activating: with the flag on and the sets inactive an applicant still
sees nothing. Activation is a separate decision and is deliberately not
expressible in the import file.

**Why the ids are chosen by the generator, not the database.** Neither catalog
table has a unique constraint other than its primary key — 005 declares
`id uuid primary key default gen_random_uuid()` and nothing else unique. With
database-generated ids, running the import twice would insert a **second
complete catalog** with no error, and every applicant would see every school
twice. With the ids fixed in the file, a second run dies on
`statement_requirement_sets_pkey` inside the transaction and inserts nothing.

---

### IF THE RUN IS UNCERTAIN — disconnect, timeout, no result, ambiguous result

**Do not rerun the import.** Not to "make sure", not to "see what happens". The
import is one transaction, so it either committed or it did not — but *you*
cannot tell which from a broken connection, and a rerun against a committed
catalog is the one action that can make this worse.

**1. Run the postcheck. Read step 100 and nothing else yet.**

```
supabase/manual/statement_requirements_catalog_import_postcheck.sql
```

Step 100 counts how many of the payload's known ids exist. That number is the
diagnosis:

| Step 100 reads | State | What you may do |
|---|---|---|
| **0 of 63 sets + 0 of 80 documents** | **DEFINITELY NOT APPLIED** | This is the only state from which a fresh write may be considered. Re-run the preflight, confirm it is clean, then seek write approval again. |
| **63 of 63 sets + 80 of 80 documents** | **FULLY APPLIED** | The import succeeded. Do not rerun it. Read the rest of the postcheck to confirm the content, then stop. |
| **anything else** | **UNEXPECTED / PARTIAL** | **STOP.** Do not rerun the import. Do not delete anything. |

**2. On DEFINITELY NOT APPLIED**, note that every check from 110 down will also
report FAIL. That is those checks correctly answering "has the catalog been
imported?" with no. It is not a malfunction and not a second problem.

**3. On FULLY APPLIED**, steps 110 and 111 compare the md5 of the ordered id
lists against the reviewed payload. "63 rows exist" is satisfied by 63 of the
*wrong* rows; a fingerprint match is not. Read both before believing the import.

**4. On UNEXPECTED / PARTIAL, stop and inspect.** A partial row count should be
impossible — the import is a single transaction and PostgreSQL does not commit
half of one. So a partial state means something other than this file wrote to
the catalog, and the question to answer is *what*, not *how do I finish the
import*. Capture the postcheck output verbatim before touching anything.

**Do not** attempt a repair by deleting the rows that did land and re-running.
The rows carry verified source URLs and verification dates; deleting them
discards evidence, and re-running on a half-populated catalog is refused by
precondition 5 anyway.

---

### The preflight is also the "has this already run?" query

Running the preflight after a successful import reports three failures by
design — the catalog is not empty (steps 300, 301) and the payload's ids are
already present (step 302). Step 302 is the precise one: it distinguishes "some
other catalog is here" from "this exact payload is here".

---

## Rollback, and its limits

**The rollback for everything except the schema is the flags.** Clear
`STATEMENT_ANALYSIS_CACHE` or `STATEMENT_REQUIREMENTS`, restart, and the product
returns to its previous behaviour with the tables in place and unread. No code
change. No data loss. That is by design and it is the only rollback that is
cheap.

What the flags do **not** undo:

- **Schema.** There is no `down` script for any of the three migrations.
  Reversing them means hand-written `drop table` / `drop column` /
  `drop function`, or PITR.
- **Dropping the two `statement_drafts` columns destroys every
  requirement-backed draft's snapshot** — the only record of what an essay was
  written against. After step 11 there is real content in there.
- **Deleting a draft now destroys its analyses, by design.** `draft_id` cascades,
  so a paid analysis is lost with the draft it describes. That is the correct
  trade — feedback quoting a deleted personal statement is the thing being
  prevented — but it is not recoverable, and PITR is the only way back.
- **PITR restores the whole project, not one table.** Rolling back a bad step
  would also roll back every unrelated row written in between: drafts, messages,
  subscriptions. PITR is a last resort, not a rollback plan.
- **A committed behavioural test is not rolled back by its own `ROLLBACK`.** If
  step 8 was run statement-by-statement, synthetic rows are real and must be
  deleted by hand using the post-rollback queries at the foot of each test file.
- **Grant drift is not a migration problem.** If step 4 or 7 shows an unexpected
  privilege, the cause is Supabase's schema default privileges, and the fix is
  `alter default privileges` — a separate change with its own review.
- **Model calls are not refundable.** Step 12 spends real money. A mistake there
  is money, not state.

---

## Isolated environment

**A disposable local PostgreSQL rehearsal has been performed. A Supabase
staging project still does not exist, and this runbook does not require one.**

### What the local rehearsal covered

All six migrations were applied to a throwaway PostgreSQL 16 cluster
(`initdb`, no TCP listener, unix socket only), against a synthetic
Supabase-shaped scaffold. **290 assertions, zero failures.** To reproduce:

```
supabase/tests/local_rehearsal_scaffold.sql          # roles, auth schema, auth.uid()
<the six migrations, in filename order>
supabase/tests/local_rehearsal_fixtures.sql          # synthetic rows
supabase/tests/statement_rls_role_session_test.sql   # as authenticated, then anon
supabase/tests/statement_analyses_concurrency_two_session.sh
```

Each of those files refuses to run against anything that looks like a managed
Supabase database, and refuses to run at all without an explicit opt-in. The
role-session test additionally **refuses a superuser or owner session**, because
such a session bypasses RLS and would pass every assertion without the policies
existing.

What it established that static inspection could not:

- The migrations apply in order, are **re-runnable with rows present**, and fail
  loudly out of order (006 without 005; 004 without `statement_drafts`).
- RLS actually bites from a genuine non-privileged session: 18 assertions as
  `authenticated`, 8 as `anon`.
- **Genuine two-session concurrency.** The duplicate-claim race was observed
  blocking on `Lock/transactionid` from a third connection, resolving to one row
  with the loser receiving no claim token; the superseded-request interleaving
  confirmed a stale token can neither settle (`not-found`) nor release
  (`released: false`) the replacement.
- Which locks the retention foreign keys take, and what they block — see step 3.

### What the rehearsal did NOT reproduce

Treat each of these as unverified until production says otherwise. A clean local
result is **weaker** evidence than a clean one on the real project, not equal to
it.

- **Supabase authentication.** No GoTrue, no JWT verification. A signed-in
  applicant was simulated by setting `request.jwt.claims` directly. The claim a
  real token would have to survive was never checked.
- **PostgREST.** No role switching, no HTTP layer, no schema cache. The tests
  connected *as* `anon` and `authenticated` over a socket, which is stricter in
  one way — no superuser in the picture — and unrepresentative in another: the
  real roles are `NOLOGIN` and are reached with `SET ROLE`.
- **Supabase schema default privileges.** Not reproduced, and this is the
  important one: default privileges are exactly what the migrations'
  revoke-before-grant exists to defeat, so a clean grant matrix locally proves
  the least about the thing most likely to differ. This is the same class of
  trap that migration 010 closed in the Resume work.
- **`auth.users` ownership and the `REFERENCES` privilege.** The rehearsal's
  `auth.users` was a six-column stand-in owned by the role that ran the
  migration, so the privilege step 3 depends on was present by construction and
  was never actually tested. Production has roughly thirty-five columns and a
  different owner.
- **Lock duration under load**, the pooler, replication, and `service_role`
  behaviour — none exercised.

### Why there is still no staging project

- No `supabase/config.toml`, so no local `supabase start` stack is configured.
- The only Supabase URL in `.env.local` points at a project ref that
  `lib/resume/migrate/target.ts` lists in `PRODUCTION_PROJECT_REFS`.
- `SUPABASE_SERVICE_ROLE_KEY` is absent from this worktree, so nothing here can
  execute DDL even if told to.

**As an option, not a prerequisite:** the harness already exists for Resume.
`lib/resume/migrate/integration.test.ts` runs real database tests when
`RESUME_MIGRATION_TARGET=staging` plus a staging project ref and keys are
supplied, and skips otherwise; its guard `lib/resume/migrate/target.ts` requires
the operator to *name* the staging project, refuses production refs by identity,
and refuses any shell carrying a production-only secret. The same pattern would
serve Statement Studio. Creating a Supabase project is a paid decision and is
yours alone.

If you do create one, verify it is genuinely isolated:

1. Its project ref differs from every entry in `PRODUCTION_PROJECT_REFS`.
2. `select count(*) from auth.users` returns a number you recognise as seed data.
3. `select count(*) from public.statement_drafts` and
   `… statement_prompts` are 0 or your own fixtures — the Arkansas State row must
   be **absent** unless you put it there.
4. The shell carries none of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `RESEND_API_KEY`, `VERCEL_OIDC_TOKEN`.
5. The dashboard confirms no deployed Vercel environment points at it.

---

## The local build failure is not a blocker

`next build` compiles successfully — webpack, the PWA client and server, and
TypeScript all pass — and then fails during **page-data collection** at
`new Resend(...)` for a messaging route, because `RESEND_API_KEY` is not in this
worktree's `.env.local`.

It has no bearing on migration readiness: the migrations are SQL pasted into the
SQL editor and no build artefact is involved. Page-data collection happens after
compilation, so it proves nothing about whether the new code builds — it does.

`lib/resume/migrate/target.ts` lists `RESEND_API_KEY` among
`PRODUCTION_ONLY_SECRETS`, so its *absence* is what this repository's own
production-detection treats as "this shell is not production". Supplying it
locally to make a build pass would defeat that check. The deployed environment
has the key and the production build is unaffected.

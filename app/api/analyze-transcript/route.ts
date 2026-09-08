import { NextResponse } from 'next/server'
import { authenticateRequest, readAccessToken } from '@/lib/apiAuth'
import {
  documentFingerprint, reserveTranscriptSource, consumeTranscriptSource,
  releaseTranscriptSource, canCreateAnotherAnalysis, TRANSCRIPT_ALLOWANCE_CODE,
  ANALYSIS_LIMIT_CODE,
} from '@/lib/gpa/transcriptEntitlement'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** A long transcript is ~40k chars. The cap bounds cost and latency. */
const MAX_INPUT_CHARS = 120_000
const OPENAI_TIMEOUT_MS = 55_000
/** Fixed so repeat analyses of one document ask for the same sampling path. */
const TRANSCRIPT_SEED = 20260904

const PROMPT_RULES = `
The transcript text is given with page and line structure preserved. Columns
within a line are separated by " | ". Use that structure.

PAGE LAYOUT — READ THIS FIRST:
Some pages are printed in TWO independent columns. Where that is so, the text
is split for you into "--- COLUMN 1 ---" and "--- COLUMN 2 ---" blocks. Each
block is its own top-to-bottom reading stream.
- Read COLUMN 1 completely, then COLUMN 2. Never pair a line in one column with
  a line in the other.
- A term heading applies to the courses that FOLLOW it in the SAME stream, and
  keeps applying until the next term heading in that stream.
- A stream may end with "CONTINUED ON NEXT COLUMN" or "CONTINUED ON PAGE n",
  and the next stream may begin with "Institution Information continued:" or a
  repeated "SUBJ NO. | COURSE TITLE" header. When it does, the term heading in
  force at the end of the previous stream CARRIES OVER to the courses at the
  start of the next one, until that stream states a new term.
- Those markers and repeated headers are structure. They are NEVER courses.
- Do not carry a term across a boundary the document does not mark as a
  continuation.

RETURN JSON. Respond with a single JSON object in EXACTLY this shape (no prose, no code fence):
{
  "institutions": [
    {
      "name": "<the school name EXACTLY as this transcript prints it>",
      "creditSystem": "semester|quarter|unknown",
      "confidence": "high|low",
      "gradingScaleTableId": "<id of the DETECTED TABLE that applies, or null>",
      "gradingScaleApplicability": "<verbatim line(s) showing that table governs this coursework>",
      "gradingScaleAmbiguity": ""
    }
  ],
  "courses": [
    {
      "institutionName": "<the school this row belongs to, as printed>",
      "courseCode": "<catalog number exactly as printed>",
      "name": "<course title exactly as printed>",
      "grade": "A",
      "credits": 4,
      "term": "Fall",
      "year": "2023",
      "level": "undergraduate|graduate|unknown",
      "categories": ["science"],
      "recordType": "coursework|transfer_notation",
      "transferredFromName": "",
      "transferredIn": false,
      "needsReview": false,
      "reviewReason": ""
    }
  ]
}

NEVER invent database IDs. Return institution NAMES only, spelled exactly as
the transcript prints them. The application resolves names to its own records.
The angle-bracket text above is a PLACEHOLDER describing what goes in each
field. NEVER copy a placeholder, and never carry over a school or course name
from any example — every value must come from THIS document.

INSTITUTIONS:
- A single PDF may bundle transcripts from MORE THAN ONE school. Detect each.
- Set "institutionName" per course to the school where that row belongs.
  Do NOT assign every course to the first school you see.
- Institution headings usually appear at the top of a page or section.

RECORD TYPE — this distinction matters more than anything else here:
- "coursework": a real graded attempt the student sat at that institution.
- "transfer_notation": the RECEIVING school's administrative line acknowledging
  credit accepted from elsewhere. Typical signals: a "TRANSFER CREDIT" block,
  a grade of TR/T, a source-school column, or wording like "Equivalent /
  Accepted Credit". These are NOT second attempts and carry no grade points.
  Set "institutionName" to the RECEIVING school and "recordType" to
  "transfer_notation".
- The SAME course may legitimately appear twice in one bundle: once as real
  coursework at the originating school, and once as transfer_notation at the
  receiving school. Return BOTH. Do not merge or drop either.

SECTION CONTEXT — a row inherits meaning from the region that contains it:
- Transcripts group rows under section headings such as "TRANSFER COURSES",
  "TRANSFER CREDIT ACCEPTED", "INSTITUTION CREDIT", or a named originating
  school. A heading governs every row that FOLLOWS it in the same reading
  stream, until the next section heading in that stream.
- A row inside a transfer-credit region is "transfer_notation" EVEN IF that row
  carries no TR marker of its own. Not every row in such a block repeats the
  marker; the block heading is the evidence.
- Row-level evidence overrides the region only when it is stronger and explicit
  (for example a real letter grade and an institutional catalog number on a row
  that clearly sits under an institutional-coursework heading).
- Section headings, totals lines ("TOTAL TRANSFER CREDITS", "DEGREE CREDITS
  EARNED", "TERM AVG", "CUMULATIVE AVG") and continuation markers are structure.
  They are NEVER courses.
- Do not carry a section heading across into an unrelated region or column.
- A school named INSIDE a transfer block is the ORIGINATING school. It does not
  become the row's institution: "institutionName" stays the school whose
  transcript this is — the one issuing the document — for every row on it.
  Naming the originating school here would split one transcript across several
  institutions and score its coursework on the wrong grading scale.
- Likewise, a term/section heading that names a college, campus or program
  within the SAME school ("School of Nursing", "College of Arts and Sciences")
  is a division of that school, not a separate institution. Return ONE
  institution per transcript unless the document genuinely bundles transcripts
  from different schools, each with its own header and its own totals.

TRANSFERRED-IN:
- "transferredIn": true on ORIGINATING coursework that the transcript indicates
  was later transferred elsewhere. This is different from recordType.
- Leave it false when the transcript does not say.

ORIGINATING SCHOOL OF A TRANSFER NOTATION:
- On a "transfer_notation" row, set "transferredFromName" to the school the
  credit came FROM, exactly as printed. It usually appears in the block heading
  ("TRANSFER CREDIT ACCEPTED FROM <SCHOOL>", "TRANSFER CREDIT FROM <SCHOOL>") or
  in a source-school column on the row itself.
- This does NOT change "institutionName". The notation still belongs to the
  RECEIVING school whose transcript this is. Both fields are required on such a
  row, and they name different schools.
- The block heading governs EVERY row inside that block, exactly as it does for
  recordType. A row that does not repeat the TR marker, or that prints no grade
  at all, still came from the school named in its heading — set
  "transferredFromName" on it too. Rows in one transfer block share one
  originating school; do not leave some of them blank.
- Leave "transferredFromName" empty only when no originating school is printed
  anywhere for that block. Never guess one, and never copy the receiving school
  into it.
- Leave it empty on "coursework" rows.

COURSE CODE — copy the catalog number EXACTLY as printed:
- Keep EVERY segment and its separators: "NURS 310", "77:705:202", "77 705 202",
  "BIOL-101". Many transcripts print school:subject:course as three groups.
- Do NOT shorten it, do NOT drop the school or subject segments, and do NOT
  reformat or renumber it.
- The subject/department segment is how the application groups coursework by
  department, so a truncated code loses real information.
- No catalog number printed -> null.

GRADES:
- Copy the grade EXACTLY as printed. Do not convert or round it.
- A+ stays "A+". W, P, S, CR, I, IP, AU, NR, TR stay unchanged.
- Unreadable or absent grade -> "" and "needsReview": true.
- NEVER supply a grade a row does not print. In particular, a row inside a
  transfer-credit section that shows a code and credits but NO grade keeps
  "grade": "". Do not fill in "TR" (or any other marker) because the section
  implies it — the section already determines "recordType", and inventing a
  grade makes the same document read differently on different passes.

CREDITS: a NUMBER, decimals allowed. Unreadable -> 0 and "needsReview": true.

ACADEMIC LEVEL:
- Use "graduate" ONLY when the transcript states it (e.g. a "GRADUATE ACADEMIC
  CAREER" heading, "Career: Graduate", or an explicit graduate section).
- Do NOT infer graduate status from a high course number alone.
- Otherwise "undergraduate" when clearly stated, else "unknown".

CREDIT SYSTEM:
- "semester" or "quarter" ONLY if the transcript says so explicitly.
- Otherwise "unknown". Do not assume semester.

DO NOT IMPORT NON-COURSES:
- Skip term totals, cumulative totals, GPA lines, "Term GPA summary" rows,
  honors/dean's-list lines, degree-awarded lines and column headers.
- Rows annotated "Summary row - not a course" are NEVER courses.
- Skip watermark and boilerplate text.

CATEGORIES (a course may have more than one):
1. "science": Biology, Chemistry, Physics, Anatomy, Physiology, Microbiology,
   Pathophysiology, Pharmacology, Organic Chemistry, Biochemistry, Genetics,
   Immunology, and other science-based medical coursework.
   Statistics and Biostatistics are NOT science here, nor are mathematics,
   psychology or sociology. They are "general" unless the transcript's own
   subject code says otherwise.
2. "nursing": a course the TRANSCRIPT files under a nursing subject or
   department -- a NURS/NUR/NSG/NURSING catalog code, or a department the
   transcript itself identifies as nursing.
   A course is NOT nursing merely because it is pharmacology or
   pathophysiology, because it is clinically relevant, because its title sounds
   medical, or because the student is enrolled in a nursing or health-sciences
   program. "PHAR 510 Advanced Pharmacology" is science, not nursing.
3. "general": everything else.
A course may hold both, but each category needs its own evidence: "NURS 210
Pathophysiology" is ["science","nursing"] because NURS is a nursing subject AND
pathophysiology is a science subject.
These categories are checked afterwards against the transcript's subject codes
and titles, and corrected where the document disagrees with them.

GRADING SCALE — READ THIS ENTIRE SECTION:

The grading tables printed on this transcript have ALREADY been read out of the
document for you and are listed under "DETECTED GRADING TABLES" below, each with
an id, the heading printed above it, and its grade/point pairs.

Your ONLY job here is to say WHICH table governs this institution's coursework:
- Put that table's id in "gradingScaleTableId".
- Quote the transcript wording that establishes it in "gradingScaleApplicability".
- Do NOT retype, correct, extend or shorten any grade/point values. They come
  from the document and are not yours to change.
- If no table is listed, set "gradingScaleTableId" to null. Never invent one.

Choosing between several tables:

You MUST NOT derive, infer, guess or reconstruct which table applies from:
- the institution's name, or anything you know about that institution
- a reported cumulative GPA, term GPA, quality points or credit totals
- arithmetic that "works out" against those totals
- the distribution of grades, or which grades appear
- the course names, codes, levels or subjects
- common knowledge, convention, or a scale you have seen elsewhere
- another institution's legend printed in the same document

If no listed table governs this institution, set "gradingScaleTableId" to null.
Reporting no table is ALWAYS correct in that case and is never penalised.

MORE THAN ONE GRADING SYSTEM ON ONE TRANSCRIPT:
Large universities print SEVERAL tables on the same legend page — for example a
standard table plus separate tables for a law school, a business school or a
particular college. These are DIFFERENT scales.
- NEVER merge them. Never take some grades from one table and some from another.
- Never average or reconcile them.
- Select a table ONLY if the document states which coursework it governs — for
  example a table headed "Standard" with a parenthetical listing the schools it
  does NOT cover, or a table headed with the exact school/college that appears
  on the coursework rows. Quote that statement in "gradingScaleApplicability".
- Then check it: the school or college printed on the student's coursework rows
  must be covered by the table you chose. If the applicable table is defined by
  exclusion, confirm the coursework's school is NOT in the exclusion list.
- If several tables could apply, or none states its applicability, or you cannot
  match the coursework's school to a table: STOP. Set "gradingScaleTableId" to
  null and put a one-sentence explanation in "gradingScaleAmbiguity" naming the
  competing table ids. Do not pick the first one, the most common one, or the
  one that looks standard.

CONFIDENCE: set "needsReview": true with a short "reviewReason" whenever you
are unsure about the institution, the record type, the level or the grade.
Flagging is always better than guessing.
`

export async function POST(request: Request) {
  // Was fully unauthenticated: anonymous callers could spend the project's
  // OpenAI budget, and the Ultimate gate existed only in the browser.
  //
  // D60: the Ultimate-only gate is replaced by the transcript allowance, taken
  // under a lock further down. A direct call to this route -- bypassing the
  // page, bypassing /api/parse-pdf, from a stale client or from curl -- reaches
  // exactly the same reservation, because the reservation is what issues the
  // source id this route's response is built on.
  const auth = await authenticateRequest()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.OPENAI_API_KEY) {
    console.error('analyze-transcript: OPENAI_API_KEY is not set')
    return NextResponse.json({ error: 'Transcript analysis is unavailable.' }, { status: 503 })
  }

  let text: string
  /** D44 retry hint. Bounded, and never trusted to change the extraction rules. */
  let focus = ''
  /** D46 filename hint. Used only when the document names no institution. */
  let nameHint = ''
  /** D48 deterministic grading tables, rendered for the applicability step. */
  let legendBlock = ''
  /**
   * D60: does this import intend to CREATE an analysis?
   *
   * 'fill' pours the transcript into an analysis that already exists, so the
   * 50-analysis cap is irrelevant to it. Only 'separate' and 'combine' need a
   * new row, and only they can hit the cap after the AI has already run.
   */
  let willCreateAnalysis = false
  try {
    const body = await request.json()
    text = typeof body?.text === 'string' ? body.text : ''
    willCreateAnalysis = body?.willCreateAnalysis === true
    focus = typeof body?.focus === 'string' ? body.focus.slice(0, 600) : ''
    // D46: a filename hint. Low confidence by construction, never authoritative.
    nameHint = typeof body?.nameHint === 'string' ? body.nameHint.slice(0, 60) : ''
    if (Array.isArray(body?.legendTables) && body.legendTables.length > 0) {
      legendBlock = '\n\nDETECTED GRADING TABLES (read from the document; do NOT change these values):\n'
        + body.legendTables.slice(0, 12).map((t: any) => {
            const pts = Object.entries(t?.points ?? {})
              .sort((a: any, b: any) => Number(b[1]) - Number(a[1]))
              .map(([g, p]: any) => `${g}=${Number(p).toFixed(2)}`).join(', ')
            return `- id "${String(t?.id ?? '')}" (page ${t?.page})\n`
              + `  heading: ${t?.caption ? String(t.caption).slice(0, 200) : '(none printed)'}\n`
              + `  grades: ${pts}`
          }).join('\n')
    }
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!text.trim()) {
    return NextResponse.json({ error: 'No text provided' }, { status: 400 })
  }
  if (text.length > MAX_INPUT_CHARS) {
    return NextResponse.json(
      { error: 'That transcript is too long to analyze automatically.' },
      { status: 413 }
    )
  }

  // D60 pre-flight: D35's existing 50-analysis cap, checked BEFORE the AI call.
  // Not a second rule -- the same limit, read early, so an account that cannot
  // hold the result never pays for it with its one lifetime transcript. No
  // reservation exists yet at this point, so nothing has to be given back.
  if (willCreateAnalysis) {
    const token = await readAccessToken()
    const room = token ? await canCreateAnotherAnalysis(token, auth.userId) : null
    if (room === false) {
      return NextResponse.json(
        { error: 'You are at the limit of saved analyses.', code: ANALYSIS_LIMIT_CODE },
        { status: 409 })
    }
  }

  // D60: take the allowance BEFORE the analysis, release it if the analysis
  // does not succeed. Reserving here rather than counting afterwards is what
  // makes two simultaneous first transcripts impossible; releasing on failure
  // is what stops an upstream timeout from permanently costing a Free user
  // their one transcript.
  //
  // The fingerprint makes the D44 second pass -- and a retry after a failure --
  // the SAME source rather than a second one. It is a hash of the text, not the
  // text: nothing recoverable is stored, here or in the ledger.
  const reservation = await reserveTranscriptSource(auth.userId, documentFingerprint(text))
  if (!reservation.ok) {
    return reservation.reason === 'allowance-used'
      ? NextResponse.json(
          { error: 'You have already used your transcript analysis.',
            code: TRANSCRIPT_ALLOWANCE_CODE },
          { status: 403 })
      : NextResponse.json(
          { error: 'Transcript analysis is unavailable right now.' }, { status: 503 })
  }
  /** Only a reservation this request created is ever given back. */
  const releaseOnFailure = async () => {
    if (!reservation.alreadyConsumed) {
      await releaseTranscriptSource(auth.userId, reservation.sourceId)
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS)

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        // temperature 0 is greedy decoding, NOT determinism: the same payload
        // has been observed to yield 36, 38 and 45 courses across runs. The
        // seed asks the provider for reproducible sampling, and json_object
        // removes the "did it wrap the JSON in prose" class of variation.
        // Neither makes the model deterministic on its own, which is why the
        // caller reconciles the result against the transcript's own totals.
        temperature: 0,
        top_p: 1,
        seed: TRANSCRIPT_SEED,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: `Extract every course from this transcript.${focus ? `\n\nIMPORTANT — THIS IS A SECOND PASS:\n${focus}` : ''}`
            + (nameHint ? `\n\nThe file was named "${nameHint}". That is a WEAK hint about the `
              + `institution and nothing more. Use it ONLY if the transcript text itself names no `
              + `school. Never let it override a school named in the document, and never use it to `
              + `label coursework that belongs to a different school.` : '')
            + legendBlock
            + `\n\nTranscript:\n${text}\n${PROMPT_RULES}`,
        }],
      }),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.error('OpenAI request failed:', response.status, detail.slice(0, 500))
      await releaseOnFailure()
      return NextResponse.json(
        { error: 'Transcript analysis failed. Please try again.' },
        { status: 502 }
      )
    }

    const data = await response.json()
    const content: string = data?.choices?.[0]?.message?.content ?? ''
    if (!content) {
      await releaseOnFailure()
      return NextResponse.json({ error: 'No courses could be read from that transcript.' }, { status: 422 })
    }

    // Return the extracted content, plus token COUNTS so wait times can be
    // understood against cost later. Numbers only: the model id, the system
    // fingerprint and the rest of the upstream payload stay here.
    // The analysis succeeded, so the allowance becomes permanent. Deleting the
    // analysis this builds, its courses, or the whole draft never undoes this.
    await consumeTranscriptSource(auth.userId, reservation.sourceId)

    const u = data?.usage ?? {}
    const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    return NextResponse.json({
      content,
      // D60: server-issued provenance. The browser never invents this, and
      // every course this response produces carries it from here on.
      transcriptSourceId: reservation.sourceId,
      usage: {
        promptTokens: count(u.prompt_tokens),
        completionTokens: count(u.completion_tokens),
      },
    })
  } catch (error: any) {
    const aborted = error?.name === 'AbortError'
    console.error('analyze-transcript failed:', aborted ? 'timeout' : error?.message)
    await releaseOnFailure()
    return NextResponse.json(
      { error: aborted ? 'Analysis timed out. Please try again.' : 'Transcript analysis failed.' },
      { status: aborted ? 504 : 500 }
    )
  } finally {
    clearTimeout(timer)
  }
}

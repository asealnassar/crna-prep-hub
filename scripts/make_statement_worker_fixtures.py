#!/usr/bin/env python3
"""
Builds lib/pdf/fixtures/statement-worker/ -- size-graded synthetic PDFs for
Phase 1 of the dedicated PDF worker verification plan.

    python3 scripts/make_statement_worker_fixtures.py

Regenerating overwrites only files inside lib/pdf/fixtures/statement-worker/.
Nothing else in lib/pdf/fixtures/ is touched.

WHAT THESE ARE FOR. Measuring worker startup, peak memory, timeout behaviour
and cleanup across the size range an applicant can actually upload, up to the
approved 4 MB ceiling. They are NOT correctness fixtures -- the eight documents
in the parent directory already cover extraction correctness, and nothing here
duplicates them.

NO LIBRARY, matching make_two_column_fixture.py and make_rotation_fixtures.py:
the PDF bytes are written by hand from the standard library alone. reportlab is
not installed in this workspace and is not needed. Hand-writing also keeps the
output byte-reproducible, because nothing inserts a timestamp, a document ID or
a producer string.

CONTENT IS FICTIONAL AND OBVIOUSLY SO. Every fixture repeats a short passage of
invented prose about an invented nurse at an invented hospital, and each page
says in its own text that it is synthetic. There is no real person, no real
employer, no patient information and no transcript data anywhere in this file.

-----------------------------------------------------------------------------
THE ONE TENSION, STATED RATHER THAN HIDDEN

Two approved limits pull against each other here:

    maximum upload            4,000,000 bytes
    maximum extracted text       50,000 characters

An uncompressed text PDF costs roughly 8 bytes of file per character of
readable text (see WORDS below). A 4 MB file of genuine selectable text
therefore carries something like half a million characters -- ten times the
extraction ceiling. There is no way to build a 4 MB *text* PDF that stays under
50,000 characters without padding it with something that is not text, and the
brief rules out image-only content.

So the fixtures are split by role rather than fudged:

    UNDER   text below the 50,000 ceiling. Extraction should SUCCEED.
    AT      text just under the ceiling. The boundary case.
    OVER    text far above the ceiling. Extraction should be REFUSED, and
            refused without silent truncation.

No approved limit was altered to make a fixture fit, and no fixture was
quietly shrunk. `01` and `02` are the extraction-success fixtures; `03`, `04`
and `05` exist to prove oversized documents are rejected, and to give the
memory and timeout tests something large to work on.
-----------------------------------------------------------------------------
THE AT FIXTURE IS SIZED BY *EXTRACTED* CHARACTERS, NOT BY PLACED ONES

Its first version counted the characters this script PLACED and assumed pdfjs
would report the same number. It does not. Phase 1B Stage 1 measured the gap:

    placed    3,260 characters per full 48-line page
    extracted 3,580 characters per full 48-line page      (+320, see below)

so a fixture built to place 48,906 characters extracted 53,706 -- over the very
ceiling it existed to sit under. The fixture was useless for its one job.

The +320 is pdfjs emitting more text items than this script emits Tj operators:
every word is placed with its own text matrix, and pdfjs inserts synthetic
spacing items where it judges a gap, each of which costs its own content plus
the separator the worker joins items with. The exact mechanism is not modelled
here and does not need to be -- the per-page figure was measured directly, and
it is exact, because every page of these fixtures carries identical words.

MEASUREMENT, NOT PREDICTION. 320 comes from two independent fixtures, and the
model reproduces both to the character:

    4 pages -> 14,320 extracted (measured)   3,580*4  + 0 digit chars  = 14,320
   15 pages -> 53,706 extracted (measured)   3,580*15 + 6 digit chars  = 53,706

WHAT IS STILL AN ESTIMATE. Whole pages are exact. The AT fixture needs a
PARTIAL final page, because whole pages step 3,580 at a time and step straight
over the 48,000-49,000 target (13 pages = 46,556, 14 pages = 50,138). How the
320 distributes across the 48 lines of a page was NOT measured, so a partial
page's share of it is apportioned pro rata. That apportionment is the only
estimated term, it is bounded by [0, 320], and the chosen fixture stays inside
the target band at both ends of that bound. Extraction testing has not yet
confirmed it.
-----------------------------------------------------------------------------

BYTES ARE SET BY POSITIONING DENSITY, NOT BY PADDING. Each word is placed with
its own text-matrix operator, which is what many real PDF producers emit and
what the parent directory's fixtures already do for their columns. It means the
content stream carries ~50 bytes of operators per ~6 characters of text. That
ratio is the only reason a few hundred pages reach 4 MB, and it is honest
structure rather than filler.
"""

import hashlib
import os

OUT_DIR = "lib/pdf/fixtures/statement-worker"

# The approved ceilings, named here so a reader does not have to infer them.
MAX_UPLOAD_BYTES = 4_000_000
MAX_EXTRACTED_CHARS = 50_000

# Where the AT fixture must land, measured the way the worker counts. Chosen
# well clear of the ceiling so that neither the apportionment below nor a small
# pdfjs version difference can push it over.
BOUNDARY_TARGET = (48_000, 49_000)

# MEASURED in Phase 1B Stage 1: characters pdfjs yields, per full page, beyond
# the characters this script places. See the docstring. Exact for whole pages;
# apportioned pro rata across a partial page, which is the one estimated term
# in this file.
PDFJS_EXTRA_CHARS_PER_FULL_PAGE = 320

PAGE_HEADER = "SYNTHETIC TEST DOCUMENT - PAGE %d - NOT REAL APPLICANT CONTENT"

PAGE_W, PAGE_H = 612, 792
MARGIN_X, TOP_Y, LINE_H, FONT_SIZE = 54, 738, 14, 9
WORDS_PER_LINE, LINES_PER_PAGE = 11, 48

# Invented prose. Deliberately bland, deliberately repetitive, and deliberately
# free of anything that could be mistaken for a real applicant's writing.
WORDS = (
    "This is synthetic fixture text generated for performance testing and it "
    "describes no real person no real hospital and no real patient encounter. "
    "The fictional nurse Jordan Vale works on a fictional unit at the invented "
    "Northgate Regional Medical Center and everything stated here was written "
    "by a script to occupy space in a test document rather than to record any "
    "actual experience or opinion belonging to anybody at all."
).split()


def esc(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def page_stream(page_no, lines=LINES_PER_PAGE):
    """One page of word-positioned text, plus the text it contains.

    Returns (stream, characters) so the caller can total the readable text
    without re-parsing the PDF it just wrote.

    `lines` exists only for the AT fixture's final page. At the default every
    page is identical to what this script has always produced, which is what
    keeps the other four fixtures byte-for-byte unchanged.
    """
    ops, chars, w = [], 0, 0
    header = PAGE_HEADER % page_no
    ops.append("BT /F1 %g Tf 1 0 0 1 %.2f %.2f Tm (%s) Tj ET"
               % (FONT_SIZE, MARGIN_X, TOP_Y + LINE_H, esc(header)))
    chars += len(header)

    for line in range(lines):
        y = TOP_Y - line * LINE_H
        x = MARGIN_X
        for _ in range(WORDS_PER_LINE):
            word = WORDS[w % len(WORDS)]
            w += 1
            ops.append("BT /F1 %g Tf 1 0 0 1 %.2f %.2f Tm (%s) Tj ET"
                       % (FONT_SIZE, x, y, esc(word)))
            # +1 for the space a reader sees between words.
            chars += len(word) + 1
            x += len(word) * FONT_SIZE * 0.5 + 3
    return "\n".join(ops), chars


def build(pages, last_page_lines=None):
    """Assemble `pages` page streams into PDF bytes. No metadata, no dates.

    `last_page_lines` shortens only the final page. Left at None every page is
    full and the bytes are exactly what earlier runs produced.
    """
    objs = ["", "<< /Type /Catalog /Pages 2 0 R >>", None,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids, first, total_chars = [], len(objs), 0
    for i in range(pages):
        short = last_page_lines is not None and i == pages - 1
        stream, chars = page_stream(i + 1, last_page_lines if short else LINES_PER_PAGE)
        total_chars += chars
        pno, cno = first + 2 * i, first + 1 + 2 * i
        kids.append("%d 0 R" % pno)
        objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
                    "/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>"
                    % (PAGE_W, PAGE_H, cno))
        objs.append("<< /Length %d >>\nstream\n%s\nendstream"
                    % (len(stream) + 1, stream))
    objs[2] = "<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(kids), pages)

    buf, offsets = bytearray(b"%PDF-1.4\n"), [0]
    for n in range(1, len(objs)):
        offsets.append(len(buf))
        buf += ("%d 0 obj\n%s\nendobj\n" % (n, objs[n])).encode("latin-1")
    xref = len(buf)
    buf += ("xref\n0 %d\n" % len(objs)).encode()
    buf += b"0000000000 65535 f \n"
    for n in range(1, len(objs)):
        buf += ("%010d 00000 n \n" % offsets[n]).encode()
    # No /ID and no /Info: both are common sources of run-to-run variation.
    buf += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(objs), xref)).encode()
    return bytes(buf), total_chars


def pages_for_bytes(target):
    """Fewest pages whose document reaches `target` bytes. Deterministic."""
    pages = 1
    while True:
        data, _ = build(pages)
        if len(data) >= target:
            return pages
        pages += 1


def page_chars(page_no, lines=LINES_PER_PAGE):
    """What page_stream(page_no, lines) would PLACE. Same arithmetic, no strings.

    Kept separate only for speed: the planner below evaluates hundreds of
    candidate documents and does not need their content streams.
    """
    chars, w = len(PAGE_HEADER % page_no), 0
    for _ in range(lines * WORDS_PER_LINE):
        chars += len(WORDS[w % len(WORDS)]) + 1
        w += 1
    return chars


def estimate_extracted(pages, last_page_lines=None, pessimistic=False):
    """Estimated length of the string the worker returns for this document.

    Mirrors the worker's own counting: items within a page are joined with a
    space (already accounted for by the +1 per word above), pages are joined
    with a newline, and pdfjs contributes PDFJS_EXTRA_CHARS_PER_FULL_PAGE more
    per full page than this script places.

    `pessimistic` charges a partial final page a FULL page of pdfjs extra,
    which is the upper bound of the only term here that was not measured.
    """
    total = 0
    for i in range(pages):
        short = last_page_lines is not None and i == pages - 1
        lines = last_page_lines if short else LINES_PER_PAGE
        total += page_chars(i + 1, lines)
        total += (PDFJS_EXTRA_CHARS_PER_FULL_PAGE if (pessimistic or not short)
                  else PDFJS_EXTRA_CHARS_PER_FULL_PAGE * lines / LINES_PER_PAGE)
    return total + max(pages - 1, 0)          # pageTexts.join("\n")


def plan_for_extracted(low, high):
    """Fewest-to-most content until the ESTIMATE lands in [low, high].

    Returns (pages, last_page_lines, estimate). Picks the candidate closest to
    the middle of the band rather than the first that fits, so the fixture is
    not left sitting against either edge. Deterministic.
    """
    middle, best, total_lines = (low + high) / 2, None, 1
    while True:
        pages = -(-total_lines // LINES_PER_PAGE)
        last = total_lines - (pages - 1) * LINES_PER_PAGE
        last = None if last == LINES_PER_PAGE else last
        est = estimate_extracted(pages, last)
        if low <= est <= high:
            distance = abs(est - middle)
            if best is None or distance < best[0]:
                best = (distance, pages, last, est)
        if est > high:
            break
        total_lines += 1
    if best is None:
        raise SystemExit("no page/line combination lands in %d-%d extracted characters" % (low, high))
    return best[1], best[2], best[3]


# name, how the page count is chosen, role, note
FIXTURES = [
    ("01_statement_100kb_under_ceiling.pdf", ("bytes", 100_000), "UNDER",
     "Baseline. Smallest realistic upload; extraction should succeed."),
    ("02_statement_at_text_ceiling.pdf", ("extracted", BOUNDARY_TARGET), "AT",
     "Boundary. Sized by ESTIMATED extracted length, to sit just under the "
     "50,000-character ceiling. Confirmed only when extraction testing runs."),
    ("03_statement_1mb_over_ceiling.pdf", ("bytes", 1_000_000), "OVER",
     "Mid-size memory and startup measurement; extraction should be refused."),
    ("04_statement_2mb_over_ceiling.pdf", ("bytes", 2_000_000), "OVER",
     "Half the upload ceiling; memory scaling."),
    ("05_statement_4mb_over_ceiling.pdf", ("bytes", 3_900_000), "OVER",
     "Largest permitted upload, held below 4,000,000 bytes."),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print("%-42s %10s %7s %8s %11s %-6s %s"
          % ("file", "bytes", "pages", "placed", "est. extr.", "role", "sha256"))
    for name, (mode, value), role, _note in FIXTURES:
        last_lines = None
        if mode == "bytes":
            pages = pages_for_bytes(value)
        else:
            pages, last_lines, _ = plan_for_extracted(*value)
        data, chars = build(pages, last_lines)

        estimate = estimate_extracted(pages, last_lines)
        worst = estimate_extracted(pages, last_lines, pessimistic=True)

        # Refuse to emit anything over the approved upload ceiling.
        if len(data) > MAX_UPLOAD_BYTES:
            raise SystemExit("%s would be %d bytes, over the %d ceiling"
                             % (name, len(data), MAX_UPLOAD_BYTES))
        # Gate on what pdfjs is expected to EXTRACT, not on what was placed.
        # Checking the placed count is the mistake that shipped a 53,706-char
        # fixture labelled AT. The pessimistic figure is used so the fixture
        # stays eligible even if the whole unmeasured apportionment goes the
        # wrong way.
        if role in ("UNDER", "AT") and worst > MAX_EXTRACTED_CHARS:
            raise SystemExit("%s is labelled %s but is estimated to extract %d "
                             "characters (worst case), over the %d ceiling"
                             % (name, role, worst, MAX_EXTRACTED_CHARS))

        path = os.path.join(OUT_DIR, name)
        with open(path, "wb") as fh:
            fh.write(data)
        print("%-42s %10d %7s %8d %11d %-6s %s"
              % (name, len(data),
                 "%d" % pages if last_lines is None else "%d+%dL" % (pages - 1, last_lines),
                 chars, round(estimate), role, hashlib.sha256(data).hexdigest()))


if __name__ == "__main__":
    main()

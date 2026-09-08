#!/usr/bin/env python3
"""
Builds lib/pdf/fixtures/08_two_column_repeated_course.pdf.

Reproduces, structurally, the two real defects a staggered two-column
transcript exposed:

  1. A QUALITY POINTS column beside the credits, with the credit value set
     close enough to its grade that the two arrive as one cell ("3.0 A") while
     the points stand alone ("12.00"). Reading the first standalone decimal
     picked the points, so every graded row was sized by its grade points.

  2. Two columns whose table headers do NOT share a baseline. Column detection
     only looked for a header repeating inside one row, so the page read as a
     single stream: the two columns interleaved line by line and every
     right-column course inherited the left column's term heading.

It also carries a repeated course (F then A) so both attempts stay distinct,
P and WD rows, which print no points column at all, a "continued on next
column" marker, printed cumulative totals, and no grading legend.

Written by hand, like the rotation fixtures, so the geometry that produces the
interleaving is controlled exactly rather than left to a PDF library. Contains
no real student data; the institution and the student are fictional.
"""

FIXTURE = "lib/pdf/fixtures/08_two_column_repeated_course.pdf"

LEFT_X, RIGHT_X = 40, 330
# The right column is offset vertically on purpose: when the two headers do not
# share a baseline, no single row repeats itself, which is exactly the case
# that used to defeat column detection.
RIGHT_OFFSET = 11


def esc(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def text_at(x, y, size, s):
    return "BT /F1 %g Tf 1 0 0 1 %.2f %.2f Tm (%s) Tj ET" % (size, x, y, esc(s))


items = []


def row(x, y, code, title, credits, grade, points):
    """One course row: code, title, then credits set right next to its grade."""
    items.append(text_at(x, y, 8, code))
    items.append(text_at(x + 52, y, 8, title))
    items.append(text_at(x + 200, y, 8, credits))
    # ~11pt after the credits: under COLUMN_GAP, so they join as one cell.
    items.append(text_at(x + 200 + 22, y, 8, grade))
    if points is not None:
        items.append(text_at(x + 250, y, 8, points))


def band(x, y, term, courses, totals):
    """A term heading, its table header, its courses and its term totals."""
    items.append(text_at(x, y, 8, term))
    for dx, label in ((0, "COURSE"), (52, "TITLE"), (200, "CR"), (222, "GR"), (250, "PTS")):
        items.append(text_at(x + dx, y - 12, 8, label))
    yy = y - 26
    for c in courses:
        row(x, yy, *c)
        yy -= 14
    items.append(text_at(x, yy - 2, 8, totals))
    return yy - 18


items += [
    text_at(40, 762, 12, "LAKESHORE TECHNICAL COLLEGE"),
    text_at(40, 750, 8, "Office of the Registrar - 12 Harbor Road - Lakeshore, New Jersey 07000"),
    text_at(40, 738, 8, "OFFICIAL ACADEMIC TRANSCRIPT - SYNTHETIC TEST DOCUMENT"),
    text_at(40, 726, 8, "Student: Test Record | Academic Level: Undergraduate | Credit System: Semester"),
    text_at(40, 710, 8, "INSTITUTION CREDIT"),
]

# ------------------------------------------------------------- left column
y = 694
y = band(LEFT_X, y, "FALL 2019", [
    ("ENG 101", "English Composition I", "3.0", "A", "12.00"),
    ("PSY 101", "General Psychology", "3.0", "B+", "9.90"),
    ("BIO 101", "General Biology", "4.0", "B", "12.00"),
    ("MAT 110", "College Algebra", "3.0", "B-", "8.10"),
], "Term GPA-Hrs: 13.0 QPts: 42.00 Term GPA: 3.231")

y = band(LEFT_X, y, "SPRING 2020", [
    ("CHM 101", "General Chemistry I", "4.0", "F", "0.00"),
    ("SOC 101", "Introduction to Sociology", "3.0", "A", "12.00"),
    ("ENG 102", "English Composition II", "3.0", "B+", "9.90"),
    ("MAT 120", "Statistics", "3.0", "B", "9.00"),
], "Term GPA-Hrs: 13.0 QPts: 30.90 Term GPA: 2.377")

# The repeated attempt: same code and title, a passing grade this time.
y = band(LEFT_X, y, "SUMMER 2020", [
    ("CHM 101", "General Chemistry I", "4.0", "A", "16.00"),
    ("PED 110", "Lifetime Fitness", "2.0", "P", None),
], "Term GPA-Hrs: 4.0 QPts: 16.00 Term GPA: 4.000")

CONTINUATION_Y = y - 4
items.append(text_at(LEFT_X - 1, CONTINUATION_Y, 8, "******** CONTINUED ON NEXT COLUMN ********"))

# ------------------------------------------------------------ right column
y = 694 - RIGHT_OFFSET
items.append(text_at(RIGHT_X, y + 26, 8, "INSTITUTION INFORMATION CONTINUED"))
y = band(RIGHT_X, y, "FALL 2020", [
    ("BIO 201", "Anatomy and Physiology I", "4.0", "A-", "14.80"),
    ("BIO 202", "Anatomy and Physiology II", "4.0", "B+", "13.20"),
    ("NTR 150", "Human Nutrition", "3.0", "A", "12.00"),
    ("COM 101", "Interpersonal Communication", "3.0", "A-", "11.10"),
], "Term GPA-Hrs: 14.0 QPts: 51.10 Term GPA: 3.650")

y = band(RIGHT_X, y, "SPRING 2021", [
    ("MIC 210", "Microbiology", "4.0", "A", "16.00"),
    ("CHM 205", "Organic and Biological Chemistry", "4.0", "B+", "13.20"),
    ("PSY 230", "Developmental Psychology", "3.0", "A", "12.00"),
    ("ART 100", "Art Appreciation", "3.0", "P", None),
    ("HIS 110", "World History", "3.0", "WD", None),
], "Term GPA-Hrs: 11.0 QPts: 41.20 Term GPA: 3.745")

y = band(RIGHT_X, y, "FALL 2021", [
    ("PHI 220", "Health Care Ethics", "3.0", "A-", "11.10"),
    ("MAT 210", "Applied Statistics", "3.0", "A", "12.00"),
    ("HLT 200", "Health Promotion", "3.0", "B+", "9.90"),
], "Term GPA-Hrs: 9.0 QPts: 33.00 Term GPA: 3.667")

items.append(text_at(RIGHT_X, y - 4, 8, "******** CONTINUED ON PAGE 2 ********"))

items += [
    text_at(40, 120, 8, "TRANSCRIPT TOTALS"),
    text_at(40, 108, 8, "INSTITUTION Ehrs | 65.000 QPts | 214.200"),
    text_at(40, 96, 8, "GPA-Hrs | 60.000 GPA | 3.570"),
    text_at(40, 78, 8, "P grades earn credit but carry no quality points. WD grades carry no hours."),
    text_at(40, 66, 8, "No grading legend is printed on this transcript."),
    text_at(40, 54, 8, "This document is fully synthetic and exists only for software quality-assurance testing."),
]

stream = "\n".join(items)
pages = [(612, 792, stream)]

objs = ["", "<< /Type /Catalog /Pages 2 0 R >>", None,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
kids, first = [], len(objs)
for i, (w, h, st) in enumerate(pages):
    pno, cno = first + 2 * i, first + 1 + 2 * i
    kids.append("%d 0 R" % pno)
    objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
                "/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (w, h, cno))
    objs.append("<< /Length %d >>\nstream\n%s\nendstream" % (len(st) + 1, st))
objs[2] = "<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(kids), len(pages))

buf, offsets = bytearray(b"%PDF-1.4\n"), [0]
for n in range(1, len(objs)):
    offsets.append(len(buf))
    buf += ("%d 0 obj\n%s\nendobj\n" % (n, objs[n])).encode("latin-1")
xref = len(buf)
buf += ("xref\n0 %d\n" % len(objs)).encode()
buf += b"0000000000 65535 f \n"
for n in range(1, len(objs)):
    buf += ("%010d 00000 n \n" % offsets[n]).encode()
buf += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objs), xref)).encode()

open(FIXTURE, "wb").write(bytes(buf))
print("wrote %s (%d bytes)" % (FIXTURE, len(buf)))

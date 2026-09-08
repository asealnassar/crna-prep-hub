#!/usr/bin/env python3
"""
Builds lib/pdf/fixtures/06_rotated_grading_legend.pdf.

Written by hand rather than with a PDF library on purpose: these fixtures exist
to pin down how lib/pdf/extract.ts turns text matrices into reading order, so
the test needs to control the matrices exactly.

Every page places its text in a "logical" frame (x rightwards, y upwards, origin
bottom-left) and then rotates that whole frame by the page's angle. Because the
text matrix carries the same rotation, a correct extractor recovers the logical
coordinates exactly -- so the assertions are about geometry, not about any one
transcript. Contains no real student data.
"""
import math

FIXTURE = "lib/pdf/fixtures/06_rotated_grading_legend.pdf"
# 07 is the SAME institution printing a CONFLICTING legend, so the
# transcript-vs-transcript conflict path can be exercised for real.
CONFLICT_FIXTURE = "lib/pdf/fixtures/07_rotated_conflicting_legend.pdf"
import sys
CONFLICT = "--conflict" in sys.argv


def esc(s):
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def place(angle_deg, ox, oy, items):
    """items: (lx, ly, size, text) in the logical frame."""
    th = math.radians(angle_deg)
    cos, sin = math.cos(th), math.sin(th)
    out = []
    for lx, ly, size, text in items:
        e = lx * cos - ly * sin + ox
        f = lx * sin + ly * cos + oy
        # Tm carries rotation only -- Tf already applies the font size, and
        # baking it into Tm as well squares the scale.
        a, b, c, d = cos, sin, -sin, cos
        out.append(
            "BT /F1 %g Tf %.4f %.4f %.4f %.4f %.4f %.4f Tm (%s) Tj ET"
            % (size, a, b, c, d, e, f, esc(text))
        )
    return "\n".join(out)


# ---------------------------------------------------------------- page 1: 0 deg
p1 = [
    (72, 720, 12, "NORTHGATE STATE UNIVERSITY"),
    (72, 702, 10, "Official Academic Transcript"),
    (72, 664, 10, "COLLEGE OF NURSING - EASTPORT"),
    (72, 646, 10, "Fall 2021"),
]
rows1 = [
    ("BIOL 101", "General Biology", "4.0", "A"),
    ("CHEM 110", "General Chemistry", "4.0", "B+"),
    ("NURS 210", "Health Assessment", "3.0", "C+"),
    ("STAT 205", "Statistics", "3.0", "B"),
    ("HIST 150", "World History", "3.0", "D"),
]
y = 626
for code, title, cr, gr in rows1:
    p1 += [(72, y, 10, code), (160, y, 10, title), (330, y, 10, cr), (380, y, 10, gr)]
    y -= 18

# --------------------------------------------- page 2: 90 deg, grading legend
LEGEND = [
    (0, 0, 12, "EXPLANATION OF GRADING SYSTEM"),
    (0, -26, 9, "A. Standard (Exception: School of Law, Livingston College, and the Business School)"),
    (0, -46, 9, "Grade"),
    (150, -46, 9, "Points"),
    (300, -46, 9, "Grade"),
    (450, -46, 9, "Points"),
]
BPLUS, CPLUS = ("3.30", "2.30") if CONFLICT else ("3.50", "2.50")
scale_a = [
    ("A", "- Distinguished", "4.00", "F", "- Failing", "0.00"),
    ("B+", "- Intermediate grade", BPLUS, "P", "- Pass (A thru C)", ""),
    ("B", "- Good", "3.00", "IN", "- Incomplete", ""),
    ("C+", "- Intermediate grade", CPLUS, "W", "- Withdrew", ""),
    ("C", "- Satisfactory", "2.00", "", "", ""),
    ("D", "- Poor", "1.00", "", "", ""),
]
ly = -64
for g1, d1, p1v, g2, d2, p2v in scale_a:
    LEGEND += [(0, ly, 9, g1), (30, ly, 9, d1), (150, ly, 9, p1v)]
    if g2:
        LEGEND += [(300, ly, 9, g2), (335, ly, 9, d2)]
        if p2v:
            LEGEND.append((450, ly, 9, p2v))
    ly -= 18

LEGEND += [(0, ly - 14, 9, "B. School of Law"), (0, ly - 32, 9, "Grade"), (150, ly - 32, 9, "Points")]
ly -= 50
for g1, d1, p1v in [("A+", "-", "4.33"), ("B+", "- Intermediate grade", "3.33"), ("B", "- Good", "3.00")]:
    LEGEND += [(0, ly, 9, g1), (30, ly, 9, d1), (150, ly, 9, p1v)]
    ly -= 18
LEGEND += [
    (0, ly - 20, 9, "REGULATIONS GOVERNING USAGE of above grade symbols are determined by each"),
    (0, ly - 34, 9, "school of the University."),
]

# ------------------------- page 3: 90 deg body plus a 135 deg watermark outlier
p3_body = [
    (0, 0, 11, "COLLEGE OF NURSING - EASTPORT"),
    (0, -22, 10, "Spring 2022"),
]
y = -44
for code, title, cr, gr in [("NURS 310", "Pathophysiology", "3.0", "A-"),
                            ("NURS 320", "Pharmacology", "3.0", "B")]:
    p3_body += [(0, y, 10, code), (110, y, 10, title), (300, y, 10, cr), (360, y, 10, gr)]
    y -= 20

# ----------------------------------- page 4: 30 deg, neither portrait nor 90 deg
p4 = [(0, 0, 11, "SKEWED SCAN NOTICE"), (0, -22, 10, "Angle Independence Check")]
y = -44
for code, title, gr in [("PHYS 101", "Physics", "B+"), ("PSYC 100", "Psychology", "A")]:
    p4 += [(0, y, 10, code), (90, y, 10, title), (250, y, 10, gr)]
    y -= 20

pages = [
    (612, 792, place(0, 0, 0, p1)),
    (612, 792, place(90, 40, 60, LEGEND)),
    (612, 792,
     place(90, 500, 80, p3_body) + "\n" +
     place(135, 300, 400, [(0, 0, 22, "NOT AN OFFICIAL ACADEMIC RECORD")])),
    (612, 792, place(30, 120, 120, p4)),
]

objs = ["", "<< /Type /Catalog /Pages 2 0 R >>", None,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
kids, first = [], len(objs)   # next object number to be appended
for i, (w, h, stream) in enumerate(pages):
    pno, cno = first + 2 * i, first + 1 + 2 * i
    kids.append("%d 0 R" % pno)
    objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] "
                "/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % (w, h, cno))
    objs.append("<< /Length %d >>\nstream\n%s\nendstream" % (len(stream) + 1, stream))
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

out = CONFLICT_FIXTURE if CONFLICT else FIXTURE
open(out, "wb").write(bytes(buf))
print("wrote %s (%d bytes, %d pages)" % (out, len(buf), len(pages)))

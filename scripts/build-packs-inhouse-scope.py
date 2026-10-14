# Builds docs/PACKS-AI-Budtender-In-House-Scope.docx. Edit the content section, then run:
#   python scripts/build-packs-inhouse-scope.py   (needs: pip install python-docx)
# Styling matches scripts/build-ai-concierge-scope.py; findings live in docs/ai-concierge-findings.md.
import os
from docx import Document
from docx.shared import Pt, RGBColor, Inches, Twips
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH

INK = "111111"         # body text and rules
MUTED = "3A3A3A"       # subtitle
GREY = "5A5A5A"        # deck lines, meta
FAINT = "6A6A6A"       # sources
HDR_GREY = "7A7A7A"    # running header
FOOT_GREY = "9A9A9A"   # footer date
WHITE = "FFFFFF"
ZEBRA = "F2F2F2"       # alternating row fill
HAIRLINE = "BFBFBF"    # row separators
CONTENT_W = 10080      # twips, 7.0in inside 0.75in margins


def _rgb(h):
    return RGBColor.from_string(h)


def _el(tag, **attrs):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn("w:" + k), str(v))
    return e


def _fmt(run, size, color=INK, bold=False, caps=False, track=None):
    """size in pt. track = letter spacing in twentieths of a point."""
    run.font.name = "Arial"
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Arial")
    run.font.size = Pt(size)
    run.bold = bold
    run.font.all_caps = caps
    run.font.color.rgb = _rgb(color)
    if track:
        run._element.rPr.append(_el("w:spacing", val=track))
    return run


def _para(host, before=0, after=4, style=None, line=264, border=None):
    """host is the document or a table cell. border = (color, sz, space)."""
    p = host.add_paragraph(style=style)
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.space_after = Pt(after)
    if line:
        p._p.get_or_add_pPr().append(_el("w:spacing", line=line, lineRule="auto"))
    if border:
        pBdr = OxmlElement("w:pBdr")
        pBdr.append(_el("w:bottom", val="single", color=border[0],
                        sz=border[1], space=border[2]))
        p._p.get_or_add_pPr().append(pBdr)
    return p


def _field(paragraph, instr):
    r = paragraph.add_run()
    r._r.append(_el("w:fldChar", fldCharType="begin"))
    t = OxmlElement("w:instrText")
    t.set(qn("xml:space"), "preserve")
    t.text = instr
    r._r.append(t)
    r._r.append(_el("w:fldChar", fldCharType="end"))
    return r


def new_doc(running_head=None, footer_date=None):
    d = Document()
    for s in d.sections:
        s.page_width, s.page_height = Inches(8.5), Inches(11)
        s.left_margin = s.right_margin = Inches(0.75)
        s.top_margin = s.bottom_margin = Inches(0.75)
        s.header_distance = s.footer_distance = Twips(640)
    n = d.styles["Normal"]
    n.font.name = "Arial"
    n.font.size = Pt(9.5)
    n.font.color.rgb = _rgb(INK)
    if running_head:
        hp = d.sections[0].header.paragraphs[0]
        hp.paragraph_format.space_after = Pt(6)
        pBdr = OxmlElement("w:pBdr")
        pBdr.append(_el("w:bottom", val="single", color="D0D0D0", sz=4, space=4))
        hp._p.get_or_add_pPr().append(pBdr)
        _fmt(hp.add_run(running_head), 7.5, HDR_GREY, track=30)
    if footer_date:
        fp = d.sections[0].footer.paragraphs[0]
        fp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        _fmt(fp.add_run(footer_date + "        "), 7.5, FOOT_GREY)
        _fmt(_field(fp, "PAGE"), 7.5, HDR_GREY)
    return d


def title(doc, eyebrow, headline, subtitle=None, meta=None):
    _fmt(_para(doc, 12, 2, line=None).add_run(eyebrow), 8.5, INK, True, True, 60)
    _fmt(_para(doc, 0, 2.5, line=None).add_run(headline), 22, INK, True)
    if subtitle:
        _fmt(_para(doc, 0, 8, line=None,
                   border=(INK, 12, 10)).add_run(subtitle), 10.5, MUTED)
    if meta:
        _fmt(_para(doc, 5, 10).add_run(meta), 8.5, GREY)


def h1(doc, text):
    p = _para(doc, 18, 5, line=None, border=(INK, 12, 6))
    p.paragraph_format.keep_with_next = True
    _fmt(p.add_run(text), 12, INK, True, True, 30)


def h2(doc, text):
    p = _para(doc, 10, 3, line=None)
    p.paragraph_format.keep_with_next = True
    _fmt(p.add_run(text), 10, INK, True, track=12)


def deck(doc, text):
    """One grey line under a heading, framing the table that follows."""
    p = _para(doc, 0, 5)
    p.paragraph_format.keep_with_next = True
    _fmt(p.add_run(text), 8.5, GREY)


def bullet(doc, segments):
    """segments: a string, or [(text, bold), ...] to bold the lead-in."""
    if isinstance(segments, str):
        segments = [(segments, False)]
    p = _para(doc, 2, 2, style="List Bullet")
    for text, bold in segments:
        _fmt(p.add_run(text), 9.5, INK, bold)


def lb(lead, rest):
    """Bold lead-in plus plain text, for bullet()."""
    return [(lead, True), (rest, False)]


def sources(doc, text):
    _fmt(_para(doc, 10, 6).add_run(text), 7.5, FAINT)


def _cell(c, text, size=8.5, bold=False, color=INK, caps=False, track=None,
          fill=None):
    tcPr = c._tc.get_or_add_tcPr()
    if fill:
        tcPr.append(_el("w:shd", val="clear", color="auto", fill=fill))
    mar = OxmlElement("w:tcMar")
    for side, w in (("top", 90), ("left", 110), ("bottom", 90), ("right", 110)):
        mar.append(_el("w:" + side, type="dxa", w=w))
    tcPr.append(mar)
    p = c.paragraphs[0]
    p.paragraph_format.space_before = Pt(1)
    p.paragraph_format.space_after = Pt(1)
    p._p.get_or_add_pPr().append(_el("w:spacing", line=264, lineRule="auto"))
    _fmt(p.add_run(str(text)), size, color, bold, caps, track)


def _grid(t, widths):
    """Fixed layout, hairline horizontals, no verticals, rows never split."""
    t.autofit = False
    tblPr = t._tbl.tblPr
    tblPr.append(_el("w:tblLayout", type="fixed"))
    tblPr.append(_el("w:tblW", type="dxa", w=CONTENT_W))
    b = OxmlElement("w:tblBorders")
    b.append(_el("w:top", val="single", color=HAIRLINE, sz=6))
    b.append(_el("w:bottom", val="single", color=HAIRLINE, sz=6))
    b.append(_el("w:insideH", val="single", color=HAIRLINE, sz=4))
    for side in ("left", "right", "insideV"):
        b.append(_el("w:" + side, val="none", color=WHITE, sz=0))
    tblPr.append(b)
    for gridCol, w in zip(t._tbl.find(qn("w:tblGrid")), widths):
        gridCol.set(qn("w:w"), str(int(CONTENT_W * w)))
    for row in t.rows:
        row._tr.get_or_add_trPr().append(_el("w:cantSplit", val="true"))
        for i, w in enumerate(widths):
            row.cells[i].width = Twips(int(CONTENT_W * w))


def _keep_together(t):
    """Hold a short table on one page: keepNext on every row but the last."""
    for row in t.rows[:-1]:
        for c in row.cells:
            for p in c.paragraphs:
                p.paragraph_format.keep_with_next = True


def table(doc, headers, rows, widths, bold_last=False, keep_together=False):
    """widths: column fractions summing to 1.0. bold_last: bold a TOTAL row.
    keep_together: for a short table that must not break across pages."""
    assert abs(sum(widths) - 1.0) < 0.001, sum(widths)
    t = doc.add_table(rows=1, cols=len(headers))
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    for i, h in enumerate(headers):
        _cell(t.rows[0].cells[i], h, 8.5, True, WHITE, True, 16, INK)
    t.rows[0]._tr.get_or_add_trPr().append(_el("w:tblHeader", val="true"))
    for r_i, row in enumerate(rows):
        last = bold_last and r_i == len(rows) - 1
        fill = ZEBRA if (last or r_i % 2 == 1) else None
        cells = t.add_row().cells
        for i, val in enumerate(row):
            _cell(cells[i], val, 8.5, last, INK, fill=fill)
    _grid(t, widths)
    if keep_together:
        _keep_together(t)
    _para(doc, 0, 4, line=None)
    return t


def kv_table(doc, rows, widths=(0.22, 0.78)):
    """Headerless summary block: bold label, zebra rows. rows = [(k, v), ...]"""
    assert abs(sum(widths) - 1.0) < 0.001, sum(widths)
    t = doc.add_table(rows=0, cols=2)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    for r_i, (k, v) in enumerate(rows):
        fill = ZEBRA if r_i % 2 == 1 else None
        cells = t.add_row().cells
        _cell(cells[0], k, 8.5, True, INK, fill=fill)
        _cell(cells[1], v, 8.5, False, INK, fill=fill)
    _grid(t, widths)
    _para(doc, 0, 4, line=None)
    return t


def callout(doc, heading, paragraphs):
    """One boxed aside with a heavy left rule. Use it once, for the one thing."""
    _para(doc, 0, 8, line=None)  # the box needs air above it
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    t.autofit = False
    tblPr = t._tbl.tblPr
    tblPr.append(_el("w:tblLayout", type="fixed"))
    tblPr.append(_el("w:tblW", type="dxa", w=CONTENT_W))
    b = OxmlElement("w:tblBorders")
    b.append(_el("w:left", val="single", color=INK, sz=24))
    for side in ("top", "bottom", "right"):
        b.append(_el("w:" + side, val="single", color=INK, sz=6))
    for side in ("insideH", "insideV"):
        b.append(_el("w:" + side, val="none", color=WHITE, sz=0))
    tblPr.append(b)
    t._tbl.find(qn("w:tblGrid"))[0].set(qn("w:w"), str(CONTENT_W))
    c = t.rows[0].cells[0]
    c.width = Twips(CONTENT_W)
    _cell(c, heading, 8.5, True, INK, True, 20)
    for para in paragraphs:
        _fmt(_para(c, 1.5, 1.5).add_run(para), 9, INK)
    t.rows[0]._tr.get_or_add_trPr().append(_el("w:cantSplit", val="true"))
    _para(doc, 0, 4, line=None)
    return t




# ---------------------------------------------------------------- content
# Builds docs/PACKS-AI-Budtender-In-House-Scope.docx: the detailed scope for a new
# stack owned by PACKS. Its LumiLink counterpart is docs/LumiLink-AI-Concierge-Scope.docx.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_PATH = os.path.join(ROOT, "docs", "PACKS-AI-Budtender-In-House-Scope.docx")
DATE = "October 15, 2026"

# (module, lo, hi, why) — realistic pace, one developer, Claude-assisted
ROWS = [
    ("Accounts and setup", 2, 3,
     "PACKS's own ElevenLabs workspace, private agent, avatar vendor account, secrets."),
    ("Avatar bake-off and custom avatar", 6, 8,
     "LiveAvatar vs D-ID on latency, lip sync, voice; vendor turnaround on the custom look."),
    ("Session token server", 4, 6,
     "Cloudflare Worker mints short-lived tokens; origin allowlist, rate limit, daily minute cap."),
    ("Website embed (Shopify theme)", 7, 10,
     "Player, mic permission, text fallback, 21+ gate, store context. Mobile Safari is the risk."),
    ("Lip sync to the agent's audio", 3, 4,
     "D-ID has a native ElevenLabs path; LiveAvatar LITE takes our audio stream."),
    ("Persona, guardrails, red-team set", 10, 14,
     "Cannabis and California rules written from scratch; human review of the red-team run."),
    ("Store knowledge", 2, 3,
     "ElevenLabs' built-in knowledge base: FAQs, policies, hours, loyalty rules."),
    ("Menu tool (AIQ Dispense)", 2, 4,
     "Extends PACKS's existing Dispense proxy Worker; returns stock and deals per store."),
    ("Transcripts, kill switch, usage report", 4, 6,
     "No dashboard to reuse: pull transcripts, a Worker on/off flag, a weekly minutes report."),
    ("Languages", 3, 4,
     "Config is quick; testing English, Spanish and 3 more with native speakers is not."),
    ("Load, real-phone testing, launch QA", 5, 7,
     "Concurrency limits per vendor plan; iPhone and Android on cellular."),
]
LO = sum(r[1] for r in ROWS); HI = sum(r[2] for r in ROWS)
assert (LO, HI) == (48, 69), (LO, HI)
# Ceiling: the non-accelerated pace, about 1.8x our realistic hours.
C_LO, C_HI = round(LO * 1.8 / 5) * 5, round(HI * 1.8 / 5) * 5          # 85-125
assert (C_LO, C_HI) == (85, 125), (C_LO, C_HI)

d = new_doc(running_head="PACKS  ·  AI BUDTENDER  ·  IN-HOUSE BUILD SCOPE", footer_date=DATE)
title(d, "PACKS", "AI Budtender: Building a New Stack In-House",
      "What it takes for PACKS to build, run and maintain its own talking budtender",
      f"Scope Brief, Draft 1  ·  {DATE}  ·  Companion to the LumiLink AI Concierge scope")

h1(d, "Summary")
kv_table(d, [
    ("The ask", "The reel's virtual budtender on packsclub.com, built and owned by PACKS instead of LumiLink."),
    ("What gets built", "PACKS's own ElevenLabs agent with a licensed avatar face, a Cloudflare Worker backend, "
                        "and live per-store stock from AIQ Dispense."),
    ("Effort", f"{LO}-{HI} hours from one developer, about 3 weeks."),
    ("Running cost", "About $0.18-0.31 per conversation minute plus about $120-205/month in plans."),
    ("Upkeep", "4-8 hours a month, carried by PACKS's one developer."),
    ("The call", "About the same effort as the LumiLink route (46-68 hours in all). LumiLink comes out ahead only if other clients share the upkeep."),
])

h1(d, "Effort")
deck(d, "One developer, Claude-assisted. Hours include build and testing. Reasons per row are in the appendix.")
table(d, ["Module", "Hrs"],
      [[r[0], f"{r[1]}-{r[2]}"] for r in ROWS]
      + [["TOTAL", f"{LO}-{HI} (excludes vendor wait and legal review)"]],
      [0.72, 0.28], bold_last=True, keep_together=True)
bullet(d, lb("Calendar: ", "about 3 weeks next to other work; a stock-avatar demo in week one. "
             "The custom avatar and counsel review set launch."))
bullet(d, lb("Ceiling: ", f"about {C_LO}-{C_HI} hours if the mobile Safari embed slips."))
bullet(d, lb("What in-house skips: ", "the multi-client dashboard, billing and the add-on fee."))

h1(d, "Cost")
table(d, ["Line", "Type", "Amount"],
      [["Voice agent minutes and LLM tokens", "Variable", "$0.085-0.125/min"],
       ["Avatar streaming (face only)", "Variable", "$0.09-0.18/min"],
       ["Avatar vendor plan", "Recurring", "About $99/month"],
       ["ElevenLabs plan", "Recurring", "$22-99/month by tier"],
       ["Cloudflare Workers", "Recurring", "$0-5/month"],
       ["Custom PACKS avatar", "One-time", "Vendor quote, not yet known"],
       ["Example: 1,000 four-minute chats a month", "", "$720-1,240 plus about $120-205 in plans"]],
      [0.45, 0.17, 0.38], bold_last=True, keep_together=True)
bullet(d, lb("Not counted here: ", "internal build hours, monthly upkeep hours, counsel's review."))

h1(d, "Rules and Risks")
bullet(d, lb("One developer: ", "if that person is out, nobody fixes an outage or a guardrail slip; the same holds on LumiLink if one developer runs it."))
bullet(d, lb("California: ", "no medical or effect claims, 21+ gate, recording and AI disclosure; counsel reviews."))
bullet(d, lb("Open to the public: ", "no login, so minute caps and rate limits ship on day one."))
bullet(d, lb("Menu platform: ", "built on AIQ Dispense; the Flowhub swap costs 4-6 more hours."))

h1(d, "Next Steps")
bullet(d, lb("Leadership: ", "compare this with the LumiLink scope and pick a path."))
bullet(d, lb("PACKS brand: ", "the avatar's look, name, personality and languages."))
bullet(d, lb("Developer: ", "confirm the Dispense proxy Worker is deployed; get avatar vendor quotes."))
bullet(d, lb("Counsel: ", "review the guardrail script and disclosures before launch."))

sources(d, f"Sources: PACKS theme and Dispense proxy Worker; AIQ Dispense Blueprint API; LumiLink codebase and build "
           f"history; Akapulu avatar price index, LiveAvatar, D-ID docs, ElevenLabs and Cloudflare pricing pages. "
           f"Accessed October 14, 2026. Prices are published ranges, not quotes; re-check before committing a budget.")

# ---------------------------------------------------------------- appendix
d.add_page_break()
h1(d, "Appendix: The Detail")

h2(d, "Hours, row by row")
table(d, ["Module", "Hrs", "Why"],
      [[r[0], f"{r[1]}-{r[2]}", r[3]] for r in ROWS],
      [0.24, 0.09, 0.67])

h2(d, "The stack")
table(d, ["Layer", "Choice", "Why", "Alternative"],
      [["Brain and voice", "ElevenLabs Agents", "30+ languages, tool calls, built-in knowledge base",
        "Anam full stack: cheaper per minute, less guardrail control"],
       ["Face", "LiveAvatar LITE or D-ID", "Face only, so the guardrails stay in our agent", "Tavus: priciest"],
       ["Backend", "Cloudflare Worker", "PACKS already runs Workers for AIQ and Dispense", "A Node server: more upkeep"],
       ["Menu", "AIQ Dispense API", "Live today; the proxy Worker already exists", "Flowhub Ecomm, once built"],
       ["Site", "Shopify theme section", "Where packsclub.com lives now", "Next.js site, after migration"]],
      [0.13, 0.20, 0.39, 0.28])

h2(d, "Monthly upkeep, 4-8 hours")
table(d, ["Task", "Hrs/month"],
      [["Vendor SDK, API and model changes", "1-2"],
       ["Prompt and guardrail tuning from transcripts", "1-2"],
       ["Compliance spot-check of transcripts", "1-2"],
       ["Menu feed breakages, store and deal updates", "0.5-1"],
       ["Usage, caps and cost monitoring", "0.5-1"],
       ["TOTAL", "4-8"]],
      [0.80, 0.20], bold_last=True, keep_together=True)
bullet(d, lb("On LumiLink: ", "the first, fourth and fifth rows are shared once other clients join; until then the same hours land on LumiLink."))

d.save(OUTPUT_PATH)

from docx import Document as D2
doc = D2(OUTPUT_PATH)
paras = [p.text for p in doc.paragraphs]
cells = [c.text for t in doc.tables for r in t.rows for c in r.cells]
cut = paras.index("Appendix: The Detail")
brief_words = sum(len(x.split()) for x in paras[:cut]) + sum(
    len(c.text.split()) for t in doc.tables[:3] for r in t.rows for c in r.cells)
print("hours", LO, HI, "ceiling", C_LO, C_HI)
print("brief words", brief_words, "total words", sum(len(x.split()) for x in paras + cells))
print("emdash", any("—" in x for x in paras + cells))

// Draws a ReportContent as a PDF with pdf-lib (pure JS: no browser, no service).
// Text only, laid out top to bottom with automatic page breaks. Standard fonts
// only encode Latin-1, so every string goes through `latin1` first: a client
// name with an emoji becomes "?" instead of throwing and losing the report.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import {
  METRIC_LABELS,
  movement,
  positionText,
  type GridData,
  type LocationReport,
  type ReportContent,
  type TrendPoint,
} from "./lib.ts";

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.44, 0.48);
const AMBER = rgb(0.71, 0.4, 0.02);

export function latin1(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7e -ÿ]/g, "?");
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(private doc: PDFDocument, private font: PDFFont, private bold: PDFFont) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = [];
    for (const para of latin1(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const trial = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(trial, size) <= width) {
          line = trial;
        } else {
          if (line) lines.push(line);
          // A single unbreakable token wider than the line (a long URL): hard-cut it.
          let rest = word;
          while (font.widthOfTextAtSize(rest, size) > width) {
            let n = rest.length;
            while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
            lines.push(rest.slice(0, n));
            rest = rest.slice(n);
          }
          line = rest;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const indent = opts.indent ?? 0;
    const lead = size * 1.4;
    for (const line of this.wrap(text, font, size, CONTENT_W - indent)) {
      this.ensure(lead);
      this.y -= lead;
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font, color: opts.color ?? INK });
    }
  }

  /** A row of columns at fixed x offsets; cells are single-line and truncated to fit. */
  row(cells: string[], xs: number[], opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    const size = 9;
    const font = opts.bold ? this.bold : this.font;
    this.ensure(size * 1.6);
    this.y -= size * 1.6;
    cells.forEach((cell, i) => {
      const max = (xs[i + 1] ?? CONTENT_W) - xs[i] - 6;
      let s = latin1(cell);
      while (s.length > 1 && font.widthOfTextAtSize(s, size) > max) s = s.slice(0, -1);
      this.page.drawText(s, { x: MARGIN + xs[i], y: this.y, size, font, color: opts.color ?? INK });
    });
  }

  /**
   * Average rank over time, lower (better) at the top. Needs two or more dated
   * points in total to mean anything; the caller checks.
   */
  lineChart(series: { name: string; color: ReturnType<typeof rgb>; dashed?: boolean; points: TrendPoint[] }[]) {
    const H = 100;
    const LEFT = 30;
    const W = CONTENT_W - LEFT - 6;
    const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
    const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((y): y is number => y !== null);
    if (xs.length < 2 || ys.length === 0) return;

    this.ensure(H + 46);
    const top = this.y - 6;
    const bottom = top - H;
    const lo = Math.min(1, ...ys);
    const hi = Math.max(...ys, lo + 1);
    const px = (x: string) => MARGIN + LEFT + (xs.indexOf(x) / (xs.length - 1)) * W;
    const py = (v: number) => top - ((v - lo) / (hi - lo)) * H;

    const grid = rgb(0.9, 0.91, 0.93);
    for (const t of [lo, (lo + hi) / 2, hi]) {
      this.page.drawLine({ start: { x: MARGIN + LEFT, y: py(t) }, end: { x: MARGIN + LEFT + W, y: py(t) }, thickness: 0.4, color: grid });
      this.page.drawText(String(Math.round(t * 10) / 10), { x: MARGIN, y: py(t) - 3, size: 7, font: this.font, color: MUTED });
    }
    for (const x of [xs[0], xs[xs.length - 1]]) {
      const label = latin1(x.slice(5));
      this.page.drawText(label, { x: px(x) - (x === xs[0] ? 0 : 20), y: bottom - 10, size: 7, font: this.font, color: MUTED });
    }
    for (const s of series) {
      const pts = s.points.filter((p): p is { x: string; y: number } => p.y !== null);
      for (let i = 1; i < pts.length; i++) {
        this.page.drawLine({
          start: { x: px(pts[i - 1].x), y: py(pts[i - 1].y) },
          end: { x: px(pts[i].x), y: py(pts[i].y) },
          thickness: 1.4,
          color: s.color,
          dashArray: s.dashed ? [4, 3] : undefined,
        });
      }
      for (const p of pts) this.page.drawCircle({ x: px(p.x), y: py(p.y), size: 2, color: s.color });
    }
    this.y = bottom - 26;
    // Direct legend under the chart, one line.
    let lx = MARGIN + LEFT;
    for (const s of series) {
      this.page.drawRectangle({ x: lx, y: this.y - 1, width: 8, height: 4, color: s.color });
      this.page.drawText(latin1(s.name), { x: lx + 11, y: this.y - 2, size: 8, font: this.font, color: MUTED });
      lx += 24 + this.font.widthOfTextAtSize(latin1(s.name), 8);
    }
    this.y -= 8;
  }

  /** The 5x5 map grid. Each cell prints its position, so colour is never the only signal. */
  heatGrid(grid: GridData) {
    const CW = 30;
    const CH = 18;
    this.ensure(CH * 5 + 14);
    const top = this.y - 4;
    for (let r = 1; r <= 5; r++) {
      for (let c = 1; c <= 5; c++) {
        const cell = grid.cells.find((x) => x.row === r && x.col === c);
        const p = cell?.position ?? null;
        const fill = !cell || p === null ? rgb(0.95, 0.95, 0.96) : p <= 3 ? rgb(0.73, 0.97, 0.82) : p <= 10 ? rgb(0.99, 0.9, 0.54) : rgb(0.99, 0.84, 0.67);
        const x = MARGIN + (c - 1) * (CW + 2);
        const y = top - r * (CH + 2);
        this.page.drawRectangle({
          x, y, width: CW, height: CH, color: fill,
          borderColor: r === 3 && c === 3 ? INK : undefined,
          borderWidth: r === 3 && c === 3 ? 1.5 : 0,
        });
        const label = !cell ? "" : p === null ? "-" : String(p);
        const tw = this.font.widthOfTextAtSize(label, 8);
        this.page.drawText(label, { x: x + (CW - tw) / 2, y: y + 6, size: 8, font: this.font, color: INK });
      }
    }
    // Caption to the right of the grid.
    const cx = MARGIN + 5 * (CW + 2) + 12;
    const lines = [
      `Map results for "${grid.keyword}"`,
      `Checked ${grid.check_date}. Centre (outlined) is your location.`,
      "Green: top 3. Yellow: 4 to 10. Orange: 11 or lower. Grey: not found.",
    ];
    lines.forEach((t, i) => {
      const wrapped = this.wrap(t, this.font, 8, PAGE_W - MARGIN - cx);
      wrapped.forEach((ln, j) => {
        this.page.drawText(ln, { x: cx, y: top - 12 - i * 22 - j * 10, size: 8, font: i === 0 ? this.bold : this.font, color: i === 0 ? INK : MUTED });
      });
    });
    this.y = top - 5 * (CH + 2) - 6;
  }

  rule() {
    this.ensure(8);
    this.y -= 4;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.5,
      color: rgb(0.85, 0.86, 0.88),
    });
    this.y -= 4;
  }
}

function locationSection(w: Writer, loc: LocationReport) {
  w.ensure(60);
  w.gap(10);
  w.text(loc.name, { size: 14, bold: true });
  w.rule();

  w.text("Where you can win", { size: 11, bold: true });
  w.text(loc.radius.statement, { size: 10 });

  w.gap(6);
  w.text("Search rankings", { size: 11, bold: true });
  const o = loc.rankings.organic;
  const l = loc.rankings.local_pack;
  if (o.checked === 0 && l.checked === 0) {
    w.text("No ranking checks were recorded for this location this month.", { size: 10, color: MUTED });
  } else {
  w.text(
    `Website results: ${o.ranked} of ${o.checked} keywords found, ${o.top3} in the top 3, ${o.top10} in the top 10` +
      (o.avg_position !== null ? `, average position ${o.avg_position}.` : "."),
    { size: 10 },
  );
  w.text(
    `Map pack: ${l.ranked} of ${l.checked} keywords found, ${l.top3} in the top 3` +
      (l.avg_position !== null ? `, average position ${l.avg_position}.` : "."),
    { size: 10 },
  );
  }
  if (loc.trend) {
    const series = [
      { name: "Website results", color: rgb(0.07, 0.09, 0.15), points: loc.trend.organic },
      { name: "Map pack", color: rgb(0.15, 0.39, 0.92), dashed: true, points: loc.trend.local_pack },
    ].filter((s) => s.points.some((p) => p.y !== null));
    if (series.length > 0) {
      w.gap(4);
      w.text("Average position over the last 13 weeks (lower is better)", { size: 8, color: MUTED });
      w.lineChart(series);
    }
  }
  if (loc.grid && loc.grid.cells.length > 0) {
    w.gap(4);
    w.heatGrid(loc.grid);
  }
  if (loc.rankings.keywords.length > 0) {
    w.gap(4);
    const xs = [0, 190, 270, 350, 430];
    w.row(["Keyword", "Website", "Change", "Map pack", "Change"], xs, { bold: true, color: MUTED });
    for (const k of loc.rankings.keywords) {
      w.row(
        [
          k.keyword,
          positionText(k.organic),
          k.organic.checked ? movement(k.organic.now, k.organic.before) : "",
          positionText(k.local_pack),
          k.local_pack.checked ? movement(k.local_pack.now, k.local_pack.before) : "",
        ],
        xs,
      );
    }
  }

  w.gap(6);
  w.text("Google Business Profile", { size: 11, bold: true });
  if (loc.profile_metrics.available) {
    const t = loc.profile_metrics.totals;
    for (const [key, label] of Object.entries(METRIC_LABELS)) {
      if (key in t) w.text(`${label}: ${t[key]}`, { size: 10 });
    }
  } else {
    w.text(loc.profile_metrics.reason, { size: 10, color: MUTED });
  }

  if (loc.backlinks) {
    w.gap(6);
    w.text("Links to your site", { size: 11, bold: true });
    const b = loc.backlinks;
    w.text(
      `${b.referring_domains ?? "–"} sites link to you (${b.total ?? "–"} links in total). ` +
        `Last full month: ${b.gained ?? "–"} gained, ${b.lost ?? "–"} lost.`,
      { size: 10 },
    );
  }

  w.gap(6);
  w.text("Work shipped this month", { size: 11, bold: true });
  if (loc.shipped.length === 0) {
    w.text("Nothing went live this month.", { size: 10, color: MUTED });
  }
  for (const s of loc.shipped) {
    const tag = s.verified ? "confirmed live" : "applied by you, not yet confirmed by us";
    w.text(`- ${s.label}${s.detail ? `: ${s.detail}` : ""} (${tag})`, { size: 10, indent: 6 });
    if (s.url) w.text(s.url, { size: 8, color: MUTED, indent: 14 });
  }

  w.gap(6);
  w.text("Queued for next month", { size: 11, bold: true });
  if (loc.queued.length === 0) {
    w.text("Nothing is waiting.", { size: 10, color: MUTED });
  }
  for (const q of loc.queued) {
    const need = q.needs === "approval" ? "waiting for your approval" : "waiting for you to apply it";
    w.text(`- ${q.label}${q.detail ? `: ${q.detail}` : ""} (${need})`, { size: 10, indent: 6 });
  }

  if (loc.site_connection && loc.site_connection.status !== "healthy") {
    w.gap(6);
    w.text(
      "Heads up: our access to your website isn't healthy, so approved changes are coming to you as instructions instead of publishing themselves.",
      { size: 10, color: AMBER },
    );
  }
}

export async function renderReportPdf(content: ReportContent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(latin1(`${content.client_name} - SEO report - ${content.period.label}`));
  doc.setCreator("LumiLink");

  const w = new Writer(doc, font, bold);
  w.text(`${content.client_name}`, { size: 20, bold: true });
  w.text(`Monthly SEO report: ${content.period.label}`, { size: 12, color: MUTED });
  w.gap(4);

  if (content.ai_visibility) {
    const a = content.ai_visibility;
    w.gap(6);
    w.text("Appearing in AI answers", { size: 11, bold: true });
    w.text(
      a.checks === 0
        ? `You're tracking ${a.queries} question${a.queries === 1 ? "" : "s"}; the first check hasn't run yet.`
        : `Your site was cited in ${a.cited} of ${a.checks} checks this month across ${a.queries} tracked question${a.queries === 1 ? "" : "s"} (Google AI Overviews and ChatGPT).`,
      { size: 10 },
    );
  }

  for (const loc of content.locations) locationSection(w, loc);

  w.gap(14);
  w.text("Nothing on your website or Google profile changes without your approval.", { size: 8, color: MUTED });

  return await doc.save();
}

// Finds missing spaces in rendered JSX copy.
//
// THE BUG THIS CATCHES. React strips the leading and trailing whitespace of a
// JSX text node when that whitespace contains a NEWLINE. So this:
//
//     AI calls are capped at {STARTER_PLAN.maxCallMinutes}
//     minutes.
//
// renders "capped at 2minutes." — the line break where a space should be is
// deleted rather than collapsed. Same for an inline element:
//
//     <strong>...not a meter.</strong>
//     We don't bill you
//
// renders "meter.We don't bill you". Both read as typos to a customer and
// neither is visible in the source, which is why this is a script and not a
// proofread.
//
// THE FIX is always one of: keep them on one line, or end the previous line
// with {" "}.
//
//   npx tsx scripts/check-jsx-spacing.ts
//
// SKIPPED BY DESIGN (tuned 2026-10-05, when 10 of 12 hits were all correct):
//
//   * A neighbouring {expression} whose every possible string output already
//     carries the gap: empty, starts/ends with a space or punctuation
//     ({cond ? `, average position ${n}` : ""}), or is a plural suffix that is
//     meant to touch ("location" + {n === 1 ? "" : "s"}). Anything the checker
//     can't resolve to literals (a variable, a call) is still flagged.
//   * Children of a flex/grid parent with a `gap-*` class: the gap spaces them.
//
// STILL FLAGGED ON PURPOSE: text before a `block` <span>. It looks fine on
// screen but the accessible name runs together ("callbackNothing gets lost"),
// which is what a radio label's screen reader reads. Fix it with {" "}.
//
// Expect "No missing spaces" — any hit is new. Fix it with {" "} at the end of
// the previous line, or by putting the two on one line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function walkDir(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkDir(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * Only INLINE neighbours can lose a space that matters.
 *
 * A <div> or <p> on the next line is block-level: no space is expected there
 * and flagging it buries the real hits. An expression or an inline tag sitting
 * against prose is the case that renders as "2minutes" or "meter.We".
 */
const INLINE_TAGS = new Set([
  "strong", "em", "b", "i", "span", "a", "code", "small", "abbr", "Link",
]);

function tagNameOf(n: ts.Node): string | null {
  if (ts.isJsxElement(n)) return n.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(n)) return n.tagName.getText();
  return null;
}

function isInlineNeighbour(n: ts.Node): boolean {
  if (ts.isJsxExpression(n)) return true;
  const tag = tagNameOf(n);
  return tag !== null && INLINE_TAGS.has(tag);
}

/**
 * Every string an expression can render, if it's made only of literals and
 * conditionals; null when any part is unknown (a variable, a call), which keeps
 * it flaggable.
 */
function literalOutputs(e: ts.Expression | undefined): string[] | null {
  if (!e) return [""];
  if (ts.isParenthesizedExpression(e)) return literalOutputs(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    // Only the literal edges matter: the head's start and the last tail's end.
    // The middle is opaque, so stand in a non-space placeholder for it.
    const spans = e.templateSpans;
    return [e.head.text + "X" + spans[spans.length - 1].literal.text];
  }
  if (e.kind === ts.SyntaxKind.NullKeyword) return [""];
  if (ts.isConditionalExpression(e)) {
    const a = literalOutputs(e.whenTrue);
    const b = literalOutputs(e.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

const PLURAL_SUFFIX = /^(s|es)$/;

/** Does this neighbouring expression already supply (or not need) the gap? */
function expressionCarriesGap(n: ts.Node, side: "start" | "end"): boolean {
  if (!ts.isJsxExpression(n)) return false;
  const outs = literalOutputs(n.expression);
  if (!outs) return false;
  return outs.every((o) => {
    if (o === "" || PLURAL_SUFFIX.test(o)) return true;
    const edge = side === "start" ? o[0] : o[o.length - 1];
    return !/[A-Za-z0-9]/.test(edge);
  });
}

/** A flex/grid container with a gap spaces its children; no text space needed. */
function parentHasGap(node: ts.JsxElement | ts.JsxFragment): boolean {
  if (!ts.isJsxElement(node)) return false;
  for (const attr of node.openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== "className") continue;
    const cls = attr.initializer?.getText() ?? "";
    return /\b(inline-)?(flex|grid)\b/.test(cls) && /\bgap-/.test(cls);
  }
  return false;
}

/** A {" "} literal — the explicit fix, so never flag it. */
function isSpaceExpression(n: ts.Node): boolean {
  return (
    ts.isJsxExpression(n) &&
    !!n.expression &&
    ts.isStringLiteral(n.expression) &&
    n.expression.text.trim() === ""
  );
}

let problems = 0;

for (const file of [...walkDir("app"), ...walkDir("components")]) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

  const visit = (node: ts.Node) => {
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && !parentHasGap(node)) {
      const kids = node.children;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        if (!ts.isJsxText(k)) continue;

        const raw = k.text;
        const hasContent = raw.trim().length > 0;
        const prev = kids[i - 1];
        const next = kids[i + 1];

        // Whitespace-only nodes are skipped: two stacked inline elements (nav
        // links, badges) are spaced by CSS, not by a text node, so flagging
        // them buried the real defects in 700 lines of noise.
        if (!hasContent) continue;

        // PUNCTUATION IS SUPPOSED TO TOUCH what precedes it. A full stop after
        // a </Link>, or a semicolon closing a list item, wants no space — so
        // only a text node that STARTS OR ENDS WITH A WORD can be a defect.
        // Without this the checker reports a dozen correct sentences and gets
        // ignored, which is worse than not having it.
        const startsWithWord = /^\s*[A-Za-z0-9]/.test(raw);
        const endsWithWord = /[A-Za-z0-9]\s*$/.test(raw);

        // Leading newline-whitespace is stripped: text butts against `prev`.
        if (
          startsWithWord &&
          /^[^\S\n]*\n/.test(raw) &&
          prev &&
          isInlineNeighbour(prev) &&
          !isSpaceExpression(prev) &&
          !expressionCarriesGap(prev, "end")
        ) {
          report(file, sf, k.getStart(sf), `"${raw.trim().slice(0, 40)}…" runs into what precedes it`);
        }
        // Trailing newline-whitespace is stripped: text butts against `next`.
        if (
          endsWithWord &&
          /\n[^\S\n]*$/.test(raw) &&
          next &&
          isInlineNeighbour(next) &&
          !isSpaceExpression(next) &&
          !expressionCarriesGap(next, "start")
        ) {
          report(file, sf, k.getStart(sf), `"…${raw.trim().slice(-40)}" runs into what follows it`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  function report(f: string, s: ts.SourceFile, pos: number, why: string) {
    const { line } = s.getLineAndCharacterOfPosition(pos);
    problems++;
    console.log(`  ${f}:${line + 1}  ${why}`);
  }

  visit(sf);
}

console.log(
  problems === 0
    ? "\nNo missing spaces in JSX copy."
    : `\n${problems} place(s) where rendered text loses a space. Fix with {" "} or one line.`,
);
process.exit(problems === 0 ? 0 : 1);

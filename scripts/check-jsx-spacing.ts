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
// SIX KNOWN-GOOD HITS as of 2026-08-13, all reviewed and all correct. It is a
// linter for prose, not a proof, so it flags shapes rather than outcomes:
//
//   demo/hvac:99, demo/orders:78   a decorative <span/> tile before "LumiLink",
//                                  spaced by the flex `gap-2.5` on the parent
//   onboarding:111                 the template literal already ends in a space
//                                  ("Setting up Acme. ")
//   onboarding:399                 the following expression starts with " · "
//   onboarding:612, :627           the following <span> is `block`, not inline
//
// If the count is still six, nothing has regressed. Fix a NEW hit with {" "} at
// the end of the previous line, or by putting the two on one line.

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
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
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
          !isSpaceExpression(prev)
        ) {
          report(file, sf, k.getStart(sf), `"${raw.trim().slice(0, 40)}…" runs into what precedes it`);
        }
        // Trailing newline-whitespace is stripped: text butts against `next`.
        if (
          endsWithWord &&
          /\n[^\S\n]*$/.test(raw) &&
          next &&
          isInlineNeighbour(next) &&
          !isSpaceExpression(next)
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

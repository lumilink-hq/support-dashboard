"use client";

// Import from Semrush or Ahrefs (module 27). The export is read in the
// browser (lib/seo-import.ts); nothing is uploaded. The person ticks what to
// track and only those values go to the importFromExport server action, which
// cleans and caps them again.

import { useState } from "react";
import { importFromExport } from "@/app/(dashboard)/seo/actions";
import { decodeExport, defaultSelection, MAX_FILE_BYTES, parseExport, type ImportRow, type ParsedImport } from "@/lib/seo-import";
import { cleanDomain, cleanKeyword, KEYWORD_MAX, KEYWORD_MIN } from "@/lib/seo-portal";

const SHOWN = 200;

function cleanFor(kind: "keywords" | "competitors", value: string): string | null {
  if (kind === "competitors") return cleanDomain(value);
  const k = cleanKeyword(value);
  return k.length >= KEYWORD_MIN && k.length <= KEYWORD_MAX ? k : null;
}

function rowNote(r: ImportRow): string {
  return [
    r.volume !== null ? `${r.volume.toLocaleString("en-US")} searches` : null,
    r.position !== null ? `position ${r.position}` : null,
    r.difficulty !== null ? `difficulty ${r.difficulty}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ImportCard({
  locationId,
  locationName,
  trackedKeywords,
  trackedCompetitors,
  keywordCap,
  competitorCap,
}: {
  locationId: string;
  locationName: string;
  trackedKeywords: string[];
  trackedCompetitors: string[];
  keywordCap: number;
  competitorCap: number;
}) {
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  async function onFile(file: File | undefined) {
    setParsed(null);
    setPicked(new Set());
    setFileName(file?.name ?? null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setParsed({ ok: false, reason: "That file is over 5 MB. Export fewer rows and try again." });
      return;
    }
    const result = parseExport(decodeExport(new Uint8Array(await file.arrayBuffer())));
    setParsed(result);
    if (result.ok) {
      const tracked = new Set(result.kind === "keywords" ? trackedKeywords : trackedCompetitors);
      const room = (result.kind === "keywords" ? keywordCap : competitorCap) - tracked.size;
      setPicked(new Set(defaultSelection(result.rows, tracked, room, (v) => cleanFor(result.kind, v))));
    }
  }

  const ok = parsed?.ok ? parsed : null;
  const tracked = new Set(ok?.kind === "competitors" ? trackedCompetitors : trackedKeywords);
  const cap = ok?.kind === "competitors" ? competitorCap : keywordCap;
  const room = cap - tracked.size;
  const noun = ok?.kind === "competitors" ? "competitor" : "keyword";
  const sourceName = ok?.source === "semrush" ? "a Semrush" : ok?.source === "ahrefs" ? "an Ahrefs" : "an";

  return (
    <div>
      <label className="block text-sm text-gray-700" htmlFor="seo-import-file">
        A keywords or competitors export (CSV or the Excel/TSV export Ahrefs makes)
      </label>
      <input
        id="seo-import-file"
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
        onChange={(e) => onFile(e.target.files?.[0])}
        className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm hover:file:bg-gray-50"
      />
      <p className="mt-1 text-xs text-gray-500">The file stays in your browser; only the rows you tick are saved.</p>

      {parsed && !parsed.ok ? <p className="mt-3 text-sm text-red-700">{parsed.reason}</p> : null}

      {ok ? (
        <form action={importFromExport} className="mt-3">
          <input type="hidden" name="location" value={locationId} />
          <input type="hidden" name="kind" value={ok.kind} />
          {[...picked].map((i) => (
            <input key={i} type="hidden" name="item" value={ok.rows[i].value} />
          ))}
          <p className="text-sm text-gray-800">
            Found {ok.rows.length.toLocaleString("en-US")} {noun}
            {ok.rows.length === 1 ? "" : "s"} in {sourceName} export{fileName ? ` (${fileName})` : ""}. {locationName} has room for{" "}
            {Math.max(room, 0)} more (up to {cap}).
          </p>
          <ul className="mt-2 max-h-80 divide-y divide-gray-100 overflow-y-auto rounded-md border border-gray-200 text-sm">
            {ok.rows.slice(0, SHOWN).map((r, i) => {
              const clean = cleanFor(ok.kind, r.value);
              const isTracked = clean !== null && tracked.has(clean);
              const disabled = clean === null || isTracked;
              const id = `seo-import-row-${i}`;
              return (
                <li key={`${r.value}-${i}`} className="flex items-start gap-2 px-2 py-1.5">
                  <input
                    id={id}
                    type="checkbox"
                    disabled={disabled}
                    checked={picked.has(i)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setPicked(next);
                    }}
                    className="mt-0.5"
                  />
                  <label htmlFor={id} className={`min-w-0 break-words ${disabled ? "text-gray-400" : "text-gray-800"}`}>
                    {r.value}
                    <span className="block text-xs text-gray-500">
                      {isTracked ? "Already tracked" : clean === null ? `Not a valid ${noun}` : rowNote(r)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {ok.rows.length > SHOWN ? <p className="mt-1 text-xs text-gray-500">Showing the first {SHOWN}.</p> : null}
          {picked.size > room ? (
            <p className="mt-2 text-xs text-amber-700">
              {picked.size} ticked but only {Math.max(room, 0)} fit; the first {Math.max(room, 0)} will be added.
            </p>
          ) : null}
          <button
            type="submit"
            disabled={picked.size === 0}
            className="mt-3 rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            Track {picked.size} {noun}
            {picked.size === 1 ? "" : "s"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

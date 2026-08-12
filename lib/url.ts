// =============================================================================
// URL normalisation for the Next app.
//
// DUPLICATED FROM supabase/functions/kb-ingest/lib.ts, deliberately. That file
// runs under Deno in an Edge Function and imports nothing; this one runs in the
// Next bundle. There is no shared module boundary between the two runtimes in
// this repo, and inventing one for thirty lines would couple the deploy of an
// edge function to a Next build.
//
// THEY MUST AGREE. The wizard writes kb_documents.source_uri using this copy,
// and the unique index on (client_id, source_uri) is what stops a re-sync
// creating a second copy of a client's whole site. If the two normalisers
// disagree, the same page arrives under two keys, the index does not fire, and
// retrieval starts returning duplicate passages — heard by the caller as the
// agent repeating itself. Change one, change both.
// =============================================================================

/**
 * Canonical form for de-duplication: no fragment, no trailing slash, no
 * tracking parameters, no embedded credentials.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      // `utm_` is a PREFIX (utm_source, utm_medium…), hence the `.*`. Anchored
      // as `^utm_$` it matches a parameter literally named "utm_" and therefore
      // nothing, letting every tracking variant through.
      if (/^(utm_.*|fbclid|gclid|msclkid|mc_[ec]id|ref|source)$/i.test(p)) {
        u.searchParams.delete(p);
      }
    }
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Turn what a client types into a fetchable address, or null.
 *
 * People type "acme.com". Rejecting that is a support ticket, so a missing
 * scheme is filled in rather than treated as an error.
 */
export function normalizeSiteUrl(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    // A bare word like "acme" parses as a valid URL with hostname "acme" and
    // would then be fetched, fail, and surface as a confusing ingestion error.
    if (!u.hostname.includes(".")) return null;
    return normalizeUrl(u.toString());
  } catch {
    return null;
  }
}

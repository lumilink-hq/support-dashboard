// =============================================================================
// seo-publish/gbp.ts — module 4 (plan.md): writing an approved edit to a Google
// Business Profile, and rolling it back. `fetch` and `sleep` are injected, so
// scripts/test-seo-publish-gbp.ts drives it against a fake Google: no network.
//
// RULE 2 (name, address, phone, primary category are never written): the only
// way to write anything is GBP_WRITABLE below, keyed by target_field, and each
// entry fixes the exact updateMask sent. A field not in it can't be written,
// whatever the action row says. 0079's CHECK on seo_actions holds the same
// list at the database.
//
// RULE 3 (previous value + idempotency): the live value is read and handed to
// `savePrior` BEFORE the PATCH; if it can't be saved, nothing is written. A
// retry after a crash reuses the saved prior instead of re-reading (which would
// return our own value). Rollback refuses when the live value is neither what
// we wrote nor what was there before: someone changed it since, and their
// change wins.
//
// RULE 6: 429 / 5xx / network errors back off exponentially (1 s, 2 s, 4 s ...)
// and retry; 401 / 403 / 404 / 400 are distinct, non-retried error kinds.
//
// GOOGLE MAY HOLD AN EDIT FOR REVIEW. The PATCH can succeed while the profile
// still shows the old text (metadata.hasPendingEdits). That is recorded as
// published-but-pending, not as a failure: the next GBP sync shows what Google
// finally accepted.
// =============================================================================

import type { ManualInstructions } from "./lib.ts";

export type GbpCtx = {
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Test only: replaces https://mybusinessbusinessinformation.googleapis.com */
  base?: string;
  maxRetries?: number; // default 3
};

export type GbpErrorKind = "auth" | "no_access" | "not_found" | "user" | "drift" | "transient";

export class GbpError extends Error {
  constructor(public kind: GbpErrorKind, message: string) {
    super(message);
    this.name = "GbpError";
  }
}

type Category = { name?: string; displayName?: string };
type Location = {
  profile?: { description?: string };
  categories?: { primaryCategory?: Category; additionalCategories?: Category[] };
  metadata?: { hasPendingEdits?: boolean };
};

/** Additional categories travel as a JSON array of category ids, sorted. */
function categoryValue(v: string): string[] {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === "string"))].sort() : [];
  } catch {
    return [];
  }
}

type FieldSpec = {
  readMask: string;
  updateMask: string;
  /** The field's value as a string (categories: a sorted JSON array of ids). */
  read: (l: Location) => string;
  /** Equal values compare equal however they were written. */
  canon: (v: string) => string;
  /** The PATCH body, given the value and the profile as just read. */
  body: (v: string, live: Location) => Record<string, unknown>;
  /** Anything the write must leave exactly as it was (rule 2). */
  unchanged?: (before: Location, after: Location) => boolean;
  label: string;
};

/** The whole allowlist (rule 2). Each field fixes its own masks and body. */
export const GBP_WRITABLE: Record<string, FieldSpec> = {
  gbp_description: {
    readMask: "profile,metadata",
    updateMask: "profile.description",
    read: (l) => l.profile?.description ?? "",
    canon: (v) => v,
    body: (v) => ({ profile: { description: v } }),
    label: "description",
  },
  // Google documents no mask for additional categories alone, so the whole
  // "categories" object is sent with the primary copied from the profile as read
  // a moment earlier, and the primary is checked again after the write.
  gbp_additional_categories: {
    readMask: "categories,metadata",
    updateMask: "categories",
    read: (l) => JSON.stringify((l.categories?.additionalCategories ?? []).map((c) => c.name ?? "").filter(Boolean).sort()),
    canon: (v) => JSON.stringify(categoryValue(v)),
    body: (v, live) => {
      const primary = live.categories?.primaryCategory?.name;
      if (!primary) throw new GbpError("user", "the profile has no primary category to keep");
      return {
        categories: {
          primaryCategory: { name: primary },
          additionalCategories: categoryValue(v).map((name) => ({ name })),
        },
      };
    },
    unchanged: (before, after) => (before.categories?.primaryCategory?.name ?? null) === (after.categories?.primaryCategory?.name ?? null),
    label: "categories",
  },
};

export function isWritable(field: string | null | undefined): boolean {
  return !!field && Object.prototype.hasOwnProperty.call(GBP_WRITABLE, field);
}

function baseUrl(ctx: GbpCtx): string {
  return (ctx.base ?? "https://mybusinessbusinessinformation.googleapis.com").replace(/\/+$/, "");
}

function validLocationName(name: string): boolean {
  return /^locations\/[^/?#]+$/.test(name);
}

async function call(ctx: GbpCtx, method: "GET" | "PATCH", url: string, body?: unknown): Promise<Location> {
  const max = ctx.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      if (attempt < max) {
        await ctx.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new GbpError("transient", `Google request failed: ${String(e)}`);
    }
    if (res.ok) return (await res.json().catch(() => ({}))) as Location;
    const text = (await res.text().catch(() => "")).slice(0, 300);
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      // not JSON
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < max) {
        await ctx.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new GbpError("transient", `Google ${res.status}: ${message}`);
    }
    if (res.status === 401) throw new GbpError("auth", `Google 401: ${message}`);
    if (res.status === 403) throw new GbpError("no_access", `Google 403: ${message}`);
    if (res.status === 404) throw new GbpError("not_found", `Google 404: ${message}`);
    throw new GbpError("user", `Google ${res.status}: ${message}`);
  }
}

export async function readField(ctx: GbpCtx, locationName: string, field: string): Promise<{ value: string; pending: boolean; location: Location }> {
  const spec = GBP_WRITABLE[field];
  if (!spec) throw new GbpError("user", `${field} is not a writable profile field`);
  if (!validLocationName(locationName)) throw new GbpError("not_found", `bad location name ${locationName}`);
  const l = await call(ctx, "GET", `${baseUrl(ctx)}/v1/${locationName}?readMask=${encodeURIComponent(spec.readMask)}`);
  return { value: spec.read(l), pending: l.metadata?.hasPendingEdits === true, location: l };
}

/** Read fresh, write, read back; throws if a protected part moved. */
async function writeField(ctx: GbpCtx, locationName: string, field: string, value: string): Promise<{ value: string; pending: boolean }> {
  const spec = GBP_WRITABLE[field]!;
  const before = await readField(ctx, locationName, field);
  await call(ctx, "PATCH", `${baseUrl(ctx)}/v1/${locationName}?updateMask=${encodeURIComponent(spec.updateMask)}`, spec.body(value, before.location));
  const after = await readField(ctx, locationName, field);
  if (spec.unchanged && !spec.unchanged(before.location, after.location)) {
    throw new GbpError("user", `Google changed a protected part of the profile while saving the ${spec.label}; stop and check the profile by hand`);
  }
  return after;
}

export type ApplyResult = { prior: string; noop: boolean; verified: boolean; pending: boolean };

/**
 * Write `proposed`. `knownPrior` is the prior saved by an earlier attempt (a
 * retry); without one the live value is read and saved through `savePrior`
 * before anything is written.
 */
export async function applyGbpField(
  ctx: GbpCtx,
  locationName: string,
  field: string,
  proposed: string,
  knownPrior: string | null,
  savePrior: (prior: string) => Promise<void>,
): Promise<ApplyResult> {
  if (!isWritable(field)) throw new GbpError("user", `${field} is not a writable profile field`);
  const { canon } = GBP_WRITABLE[field];
  let prior = knownPrior;
  if (prior === null) {
    prior = (await readField(ctx, locationName, field)).value;
    await savePrior(prior);
  }
  if (canon(prior) === canon(proposed)) return { prior, noop: true, verified: true, pending: false };

  const after = await writeField(ctx, locationName, field, proposed);
  const verified = canon(after.value) === canon(proposed);
  return { prior, noop: false, verified, pending: !verified && after.pending };
}

/** Put `prior` back, unless the profile was changed since we wrote `written`. */
export async function revertGbpField(ctx: GbpCtx, locationName: string, field: string, written: string, prior: string): Promise<{ noop: boolean }> {
  if (!isWritable(field)) throw new GbpError("user", `${field} is not a writable profile field`);
  const { canon, label } = GBP_WRITABLE[field];
  const live = await readField(ctx, locationName, field);
  if (canon(live.value) === canon(prior)) return { noop: true };
  // Google may still be reviewing our edit (live shows the old value, which is
  // the prior, handled above). Anything that is neither ours nor the prior is
  // someone else's change.
  if (canon(live.value) !== canon(written)) {
    throw new GbpError(
      "drift",
      label === "description"
        ? "the description was changed on Google since LumiLink published it, so LumiLink won't overwrite it"
        : `the ${label} were changed on Google since LumiLink published them, so LumiLink won't overwrite them`,
    );
  }
  await writeField(ctx, locationName, field, prior);
  return { noop: false };
}

// -----------------------------------------------------------------------------
// When LumiLink can't apply it: steps for a person, in the profile's own words.
// -----------------------------------------------------------------------------

export type GbpManualReason = "no_site_connection" | "connection_revoked" | "missing_scope" | "resource_not_found" | "resource_lookup_failed";

const GBP_WHY: Record<GbpManualReason, string> = {
  no_site_connection: "Google Business Profile isn't connected to LumiLink for this location yet.",
  connection_revoked: "LumiLink's access to Google was revoked or has expired.",
  missing_scope: "The Google account connected to LumiLink can't edit this profile.",
  resource_not_found: "LumiLink couldn't find this profile on Google any more.",
  resource_lookup_failed: "Google refused the change",
};

export function gbpManualInstructions(field: string, proposed: string, reason: GbpManualReason, detail?: string): ManualInstructions {
  const why = GBP_WHY[reason] + (detail ? ` (${detail})` : reason === "resource_lookup_failed" ? "." : "");
  return {
    reason,
    why,
    steps:
      field === "gbp_additional_categories"
        ? [
            "Search for the business on Google while signed in to an account that manages the profile, or open business.google.com.",
            "Choose Edit profile, then Business information, then Business category.",
            "Leave the primary category as it is. Set the additional categories to the list below and save.",
          ]
        : field === "gbp_description"
        ? [
            "Search for the business on Google while signed in to an account that manages the profile, or open business.google.com.",
            "Choose Edit profile, then Business information, then Description.",
            "Replace the description with the text below and save. Google may review the change before it shows.",
          ]
        : ["Open the profile on business.google.com and make the change shown below."],
    copy: {
      label: field === "gbp_description" ? "Description" : field === "gbp_additional_categories" ? "Additional categories (Google category ids)" : "Value",
      text: field === "gbp_additional_categories" ? categoryValue(proposed).join("\n") || "(none)" : proposed,
    },
  };
}

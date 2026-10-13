// Pure helpers for loyalty-klaviyo (0205): request bodies and response
// handling for Klaviyo's API. No network, no Deno APIs, so
// scripts/test-loyalty-klaviyo.ts tests them with tsx.
//
// Read 2026-10-13 (developers.klaviyo.com): current revision 2026-07-15.
// Create Event POST /api/events (events:write; burst 350/s, steady 3500/m),
// metric by name, profile by email, unique_id dedupes, 202 on success.
// Create or Update Profile POST /api/profile-import (profiles:write).

export const KLAVIYO_BASE = "https://a.klaviyo.com/api";
export const KLAVIYO_REVISION = "2026-07-15";

export function klaviyoHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${apiKey}`,
    accept: "application/vnd.api+json",
    "content-type": "application/vnd.api+json",
    revision: KLAVIYO_REVISION,
  };
}

export type DueEvent = { id: number; metric: string; unique_id: string; time: string; email: string; properties: Record<string, unknown> };

export function eventBody(e: DueEvent) {
  return {
    data: {
      type: "event",
      attributes: {
        properties: e.properties,
        time: e.time,
        unique_id: e.unique_id,
        metric: { data: { type: "metric", attributes: { name: e.metric } } },
        profile: { data: { type: "profile", attributes: { email: e.email } } },
      },
    },
  };
}

export type DueProfile = { member_id: string; email: string; properties: Record<string, unknown>; hash: string };

/** Upsert by email. Only custom properties: never consent, never subscriptions. */
export function profileBody(p: DueProfile) {
  return { data: { type: "profile", attributes: { email: p.email, properties: p.properties } } };
}

/** Klaviyo's JSON:API errors, flattened. */
export function errorText(status: number, body: unknown): string {
  const errs = (body as { errors?: { title?: string; detail?: string; code?: string }[] } | null)?.errors;
  const msg = Array.isArray(errs) && errs.length
    ? errs.map((e) => [e.code, e.detail || e.title].filter(Boolean).join(": ")).join("; ")
    : "";
  return `Klaviyo ${status}${msg ? `: ${msg}` : ""}`;
}

/** Wait from a 429's Retry-After (seconds), capped; default 2s. */
export function retryAfterMs(header: string | null, capMs = 30_000): number {
  const s = Number(header);
  return Number.isFinite(s) && s > 0 ? Math.min(Math.ceil(s * 1000), capMs) : 2000;
}

/** Retry the same request? (rate limit or a Klaviyo-side error) */
export const isRetryable = (status: number) => status === 429 || status >= 500;

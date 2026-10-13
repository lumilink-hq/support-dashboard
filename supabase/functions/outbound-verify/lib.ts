// =============================================================================
// outbound-verify/lib.ts — pure helpers for outbound-verify: turn a Reoon
// power-mode response into what outbound_record_verification (0303) stores.
// No network, no Deno APIs, so scripts/test-outbound-verify.ts can run it
// under Node.
//
// Reoon power-mode statuses (emailverifier.reoon.com API docs, 2026-10-13):
// safe, invalid, disabled, disposable, inbox_full, catch_all, role_account,
// spamtrap, unknown.
// =============================================================================

export type Verification = "valid" | "invalid" | "catch_all" | "unknown" | "disposable";

export type Mapped = {
  verification: Verification;
  /** Add the address to outbound_suppressions so it's never tried again. */
  suppress: boolean;
  /** Kept in the 'verify' event so a result can be checked later. */
  detail: Record<string, unknown>;
};

export type VendorError = {
  error: string;
  /** Credits or the key are the problem: stop the run, don't burn the batch. */
  fatal: boolean;
};

const KEPT_FIELDS = [
  "status", "overall_score", "is_safe_to_send", "is_deliverable", "is_catch_all", "is_role_account",
  "is_disposable", "is_disabled", "has_inbox_full", "is_spamtrap", "is_free_email", "can_connect_smtp",
  "mx_accepts_mail", "verification_mode",
];

function pick(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEPT_FIELDS) if (k in r) out[k] = r[k];
  return out;
}

/**
 * Maps one response. Role accounts (info@, hello@) are exactly the inboxes a
 * small business reads, so a role account Reoon could deliver to is valid,
 * not a reject. A full inbox is a bounce today but not forever: invalid now,
 * not suppressed.
 */
export function mapReoon(response: unknown): Mapped | VendorError {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { error: "reoon: unreadable response", fatal: false };
  }
  const r = response as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status.toLowerCase() : "";

  // Reoon reports account problems as status "error" with a reason.
  if (status === "error" || (!status && typeof r.reason === "string")) {
    const reason = String(r.reason ?? r.message ?? "unknown error");
    const fatal = /credit|balance|key|unauthori[sz]ed|quota|limit/i.test(reason);
    return { error: `reoon: ${reason}`, fatal };
  }

  const detail = pick(r);
  switch (status) {
    case "safe":
      return { verification: "valid", suppress: false, detail };
    case "role_account": {
      const deliverable = r.is_deliverable === true || r.is_safe_to_send === true;
      if (r.is_catch_all === true) return { verification: "catch_all", suppress: false, detail };
      return { verification: deliverable ? "valid" : "unknown", suppress: false, detail };
    }
    case "catch_all":
      return { verification: "catch_all", suppress: false, detail };
    case "unknown":
      return { verification: "unknown", suppress: false, detail };
    case "inbox_full":
      return { verification: "invalid", suppress: false, detail };
    case "invalid":
    case "disabled":
    case "spamtrap":
      return { verification: "invalid", suppress: true, detail };
    case "disposable":
      return { verification: "disposable", suppress: true, detail };
    // Quick-mode statuses, in case the mode ever changes.
    case "valid":
      return { verification: "valid", suppress: false, detail };
    default:
      return { error: `reoon: unexpected status '${status || "(none)"}'`, fatal: false };
  }
}

export function isVendorError(m: Mapped | VendorError): m is VendorError {
  return "error" in m;
}

# Usage limiter — remaining wiring

**2026-07-29.** Layers 1 and 4 have their logic built and tested in the `lib.ts` files. What's
left is the call-site in each `index.ts` — I couldn't reach those two files (the device bridge
dropped mid-task and they were never staged). Each is a small insert.

| Layer | Where | Status |
|---|---|---|
| 1 — pre-call gate | `voice-personalization/index.ts` | logic built + tested; **needs the insert below** |
| 2 — per-call ceiling | ElevenLabs agent settings | config only: `max_call_secs` 180 |
| 3 — mid-call wrap-up | `voice-order-lookup/index.ts` | ✅ **done** |
| 4 — post-call meter | `voice-call-logger/index.ts` | logic built + tested; **needs the insert below** |

Run `npx tsx scripts/test-limiter-helpers.ts` — 42 checks — after either edit.

---

## Layer 1 — `voice-personalization/index.ts`

Insert after the client row is resolved and `readClientConfig` has produced `cfg`, and
**before** the normal `buildResponse(...)` return.

```ts
// --- Usage limiter, layer 1: the pre-call gate. -----------------------------
// Cheapest possible place to stop an over-cap call: ElevenLabs asks for
// personalization BEFORE the agent picks up, so deflecting costs ~8 seconds of
// minutes instead of a 2-3 minute conversation.
let allowance: unknown = null;
try {
  const { data } = await supabase.rpc("check_voice_allowance", {
    p_client_id: clientId,
  });
  allowance = data;
} catch (e) {
  // Fail OPEN — see shouldDeflect. A few cents of overage beats a caller who
  // thinks the business hung up on them.
  console.error("check_voice_allowance failed (allowing call)", String(e));
}

if (shouldDeflect(allowance)) {
  console.log("voice cap reached", {
    client: cfg.slug,
    reason: (allowance as any)?.reason,
    minutes_used: (allowance as any)?.minutes_used,
  });
  return jsonResponse(
    buildDeflectResponse(cfg, services, { supportEmail: row.support_email ?? null }),
  );
}
```

Add to the import from `./lib.ts`:

```ts
import { buildDeflectResponse, shouldDeflect } from "./lib.ts";
```

Two notes:

- `supportEmail` is optional and degrades gracefully. If the row `select` in that file doesn't
  already include `support_email`, either add it to the column list or pass `null` — the
  deflect message just drops the "email us at …" clause. It will not produce a dangling
  sentence; there's a test for that.
- Replace `jsonResponse(...)` with whatever that file's existing response helper is called.

## Layer 4 — `voice-call-logger/index.ts`

Insert near the end, after the transcript turns are logged and the escalation branch has run.
This is what actually makes layers 1 and 3 able to decide anything — without it the caps sit
in the database and nothing ever counts toward them.

```ts
// --- Usage limiter, layer 4: the meter. -------------------------------------
const usageKey = usageKeyFor(fields);
if (usageKey) {
  const durationSecs = extractDurationSecs(payload);
  const { data: usage, error: usageErr } = await supabase.rpc("record_call_usage", {
    p_client_id: clientId,
    p_call_sid: usageKey,
    p_duration_secs: durationSecs,
    // Cost is derived server-side from duration x the client's rate.
    p_est_cost_usd: null,
    p_started_at: null,
    p_source: "post_call",
  });

  if (usageErr) {
    console.error("record_call_usage failed", usageErr.message);
  } else if (usage?.duplicate) {
    // Expected on a webhook retry, and worth seeing: a silent double-count
    // would falsely trip the cap and take the client's line down.
    console.log("usage already recorded for", usageKey);
  } else if (usage?.crossed_warning) {
    console.warn("VOICE CAP 80%", {
      client_id: clientId,
      minutes_used: usage.minutes_used,
      minutes_cap: usage.minutes_cap,
    });
  }
}
```

Add to the import from `./lib.ts`:

```ts
import { extractDurationSecs, usageKeyFor } from "./lib.ts";
```

> `crossed_warning` is true on exactly one call — the one that crosses 80% — so this is the
> hook for the "someone should decide whether to raise the cap" alert. A `console.warn` is a
> placeholder; it wants to become an email alongside the ticket notifications.

---

## After both inserts

1. `npx tsx scripts/test-limiter-helpers.ts` → 42 checks
2. `supabase db push` (applies `0012` and `0013`)
3. `supabase functions deploy voice-order-lookup --no-verify-jwt`
4. `supabase functions deploy voice-personalization --no-verify-jwt`
5. `supabase functions deploy voice-call-logger --no-verify-jwt`
6. End-to-end test: set `monthly_minutes: 1` on a test client, place a call, confirm the
   deflect message plays and the call ends — then restore the real cap.

## Still not built

- The 2-minute call policy in the agent prompt (layer 2's real mechanism — the CFO model
  lists it as *Required, before Tsunami*).
- Ticket + callback system (`0014`), which is demo-critical while there's no transfer line.
- `lookup_order.json` for `docs/elevenlabs-tools/`.
- `.gitattributes` from the commit checklist.

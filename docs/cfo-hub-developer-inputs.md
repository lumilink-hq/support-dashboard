# CFO Financial Hub — Developer Inputs & Review

**2026-07-29.** Review of `docs/LumiLink_CFO_Financial_Hub.xlsx` (v1.0, as of 2026-07-28)
from the engineering side: the cells assigned to **Developer**, plus four things in the model
I think are wrong or unmodeled.

**I did not edit the workbook.** It contains a chart and 13 drawing objects, and openpyxl
silently drops those on save — I'd have handed you back a model with the CFO's chart missing.
Paste-in values below instead; it's a two-minute job and your formatting survives.

---

## 1. First: the sheet explains the 100-minute mandate

`Assumptions!B13` — **Starter includes 100 voice minutes/month** at `B11` = **$149/mo**.
That's where the boss's number came from: **Tsunami is being modeled as a Starter client.**

That also means `Assumptions!B15` applies: **maximum AI call length = 2 minutes**, listed in
the Executive Summary as *"Call guardrail — Required — owner Developer — timing: before
Tsunami."* The model computes `Calls at cap = minutes ÷ 2`, so the entire revenue case rests
on it.

**This supersedes my earlier `max_call_secs` advice.** I recommended 300s, then 420s. Both
are withdrawn — see the web-demo checklist §5. The reconciliation: the sheet's guardrail is
*"soft warning, confirmation, then transfer/callback ticket or hang-up"* — a **prompt
policy**, not a guillotine. Implement that at ~2 min and set the hard timer to **180s** as a
backstop. My worry about cutting someone off mid-phone-number goes away, because the policy
converts the call to a ticket *before* the timer is ever reached.

---

## 2. Cells to fill — Developer-owned

| Cell | Enter | Confidence | Why |
|---|---|---|---|
| **B44** Twilio Media Streams | **0** | **Verified** | The architecture uses ElevenLabs' native Twilio integration — no media server, no Media Streams. Also set `D44` → `Verified — not used`. Removes a $0.0044/min line entirely. |
| **B47** LLM input tokens/call-min | **7500** | *Estimate* | ~5 turns/min × ~1,500 input tokens (cached system prompt + growing transcript). |
| **B48** LLM output tokens/call-min | **300** | *Estimate* | ~5 turns/min × ~60 tokens — spoken replies are short by design. |
| **B52** Zapier tasks per completed call | **0** | **Verified — structural** | The voice path touches Zapier **zero** times. It's Supabase Edge Functions + Postgres RPCs end to end (`voice-personalization` → `voice-order-lookup` → `voice-call-logger`). See §3. |
| **B53** Zapier tasks per unresolved ticket | **0** | **Verified — structural** | Tickets are a Postgres RPC (`create_ticket`); the notification email goes through Resend/SES from an edge function. No Zapier. |
| **B55** Railway incremental/client | **0** | Defensible now | Railway hosts one Next.js dashboard serving all tenants. No per-client marginal until traffic grows — revisit above ~25 clients. |
| **B57** Supabase incremental/client | **0** | Defensible now | Per call: ~3 edge invocations + ~8 RPCs + a few KB of rows. Pro includes 2M invocations. One watch item: `orders_cache.raw_store` keeps the **full order JSON** per order — trivial at 50 orders/month/client, worth revisiting at scale. |
| **B60** Public demo phone numbers | **1** if you keep a callable demo line; **0** if the tsunami.store demo is web-only | Verified | Browser calls have no Twilio number. A web-only demo needs no number at all. |

### B47/B48 — read this before entering the estimate

Two problems, one of them a model bug:

1. **Wrong vendor.** Rows B45/B46 are priced as *Claude Haiku 4.5*, but the voice agent runs
   **Gemini Flash** (native in ElevenLabs, billed as an at-cost pass-through). Either repoint
   B45/B46 to Gemini Flash rates, or relabel them so the model isn't asserting a vendor
   that isn't in the call path. At Haiku rates my estimate gives **~$0.009/min**; Gemini
   Flash would be roughly a third of that. Either way it's noise — see §4.
2. **The Checks tab can't tell an estimate from a measurement.** `Checks!F14` is
   `IF(B14>0,"OK","NEEDS INPUT")` — entering *any* number flips it green. So the moment you
   paste my estimate, the model reports itself more loaded than it is. Set `D47`/`D48` to
   `Estimate — pending telemetry` and flag it to the CFO. **This applies to every
   `>0 = OK` check on that tab.**

My recommendation: enter the estimates anyway. `$0` understates cost, and a labelled estimate
beats a confident zero.

---

## 3. The Zapier lines are structurally wrong — and there's a real cost hiding behind them

`Checks!A16/A17` mark "Zapier tasks/call" and "tasks/ticket" as **NEEDS INPUT** until they're
`> 0`. **They will never truthfully be > 0.** The voice product doesn't use Zapier. Those two
checks can't go green without entering a false number, so the model can never reach `PASS`.
Recommend changing both checks to `confirmed 0` rather than `> 0`.

**But** — and this is the part worth taking to the CFO — Zapier cost hasn't disappeared, it's
just been made invisible:

- `Checks!A24` says *"Email pricing removed from live model."* Fine as a pricing decision.
- **Tsunami still has a live email agent**, and the email path is 100% Zapier: roughly
  **11 billed actions per email** on the happy path (per `docs/email-agent-zap-build.md`).
- Zapier Professional includes **750 tasks/month** (`B50`) across the **whole shared
  account** — that's about **68 emails/month, total, for all clients combined**.
- At the model's 10-client forecast (`E5`), that's **~7 emails per client per month** before
  overage, then **$0.0334/task ≈ $0.37 per additional email** (`B51`).

So if email is bundled into the $149 Starter, the model currently shows $0 for a cost that
starts biting at the seventh email. Either price email as an add-on, exclude it from Starter
explicitly, or add an email-volume driver to Assumptions. **`B51` also still says
`VERIFY ACCOUNT`** — worth confirming on the Billing page regardless, since the rate is
account-specific.

---

## 4. What the numbers actually say — the margin lever isn't vendors

Starter, Expected scenario (`B30` = 0.65 utilization → 65 of 100 minutes used):

| Line | Cost |
|---|---|
| Twilio number | $1.15 |
| Twilio minutes (65 × $0.0085) | $0.55 |
| ElevenLabs (65 × $0.08) | $5.20 |
| LLM (65 × ~$0.009, my estimate) | $0.59 |
| Zapier / hosting / DB | $0.00 |
| **Vendor subtotal** | **$7.49** |
| Developer care (2 hrs × 0.5 × $25) | **$25.00** |
| **Known cash cost** | **~$32.49** |
| **Cash contribution** on $149 | **~$116.51 (78%)** |

**Vendors are $7.49. Labor is $25 — 77% of variable cost.** Negotiating ElevenLabs or Twilio
moves almost nothing; **one extra support hour per client per month costs more than every
vendor line combined.** If margin needs defending, it's defended in ticket deflection and
onboarding efficiency, not procurement.

Second-order, and it's a big one: **calls-per-dollar is set by average call length, and two
engineering choices control it.**

| Scenario | Avg call | Calls in 65 min |
|---|---|---|
| 2-min policy + staleness rule fixed | 2.0 min | **32** |
| No 2-min policy (natural length) | 2.9 min | 22 |
| No policy **and** staleness rule unfixed | 4.3 min | **15** |

The `evaluate_flag` staleness bug — where a shipped order older than 24h escalates every
WISMO call — **halves the calls a Starter plan can serve.** That's not a support-quality
issue, it's a unit-economics issue, and it belongs in front of the CFO as one.

---

## 5. B59 — public demo minutes, and how to make the number true

`B59` (**INPUT REQUIRED**, "Website demo usage paid by LumiLink") is exactly the
tsunami.store embed. A public storefront widget draws **curiosity clicks, not support calls**,
and every one costs minutes on LumiLink's bill.

Don't forecast it — **enforce it.** `0012` lets you cap the demo client row, so B59 becomes a
policy number rather than a guess:

```sql
update clients set settings = settings || jsonb_build_object('voice_caps',
  jsonb_build_object('monthly_minutes', 200, 'daily_minutes', 20,
                     'max_call_secs', 180, 'enabled', true))
 where slug = 'tsunami-demo';
```

Then enter **B59 = 200** (≈ **$16/month** at $0.08/min; browser calls carry no Twilio cost).
The `daily_minutes: 20` sub-cap is the real protection: if the page gets linked somewhere
busy, that day costs $1.60 instead of a surprise invoice.

---

## 6. Not mine to fill — flagging for the CEO

`B39` owner hourly value · `B58` website/domain/monitoring · `B61` payment processing ·
`B62` CAC · `B63` churn · `B64` bookkeeping · `B65` insurance · `B66` other SaaS.

One note on **B58**: embedding on tsunami.store is the *client's* site, so it adds no hosting
cost to LumiLink. That cell is only LumiLink's own web presence.

---

## 7. Suggested paste-in

```
Assumptions!B44 = 0          ; D44 → "Verified — not used (native Twilio integration)"
Assumptions!B47 = 7500       ; D47 → "Estimate — pending telemetry"
Assumptions!B48 = 300        ; D48 → "Estimate — pending telemetry"
Assumptions!B52 = 0          ; D52 → "Verified — voice path does not use Zapier"
Assumptions!B53 = 0          ; D53 → "Verified — tickets are Postgres RPCs"
Assumptions!B55 = 0          ; D55 → "Verified — no measurable incremental below ~25 clients"
Assumptions!B57 = 0          ; D57 → "Verified — no measurable incremental below ~25 clients"
Assumptions!B59 = 200        ; D59 → "Policy — enforced by voice_caps on tsunami-demo"
```

Plus three edits that need the CFO's agreement, not just mine:

1. `Checks!F16`/`F17` → treat **confirmed 0** as OK; they can't otherwise reach `PASS`.
2. `Assumptions!B45/B46` → repoint to Gemini Flash, or relabel (voice doesn't run Claude).
3. Add an **email-volume driver**, or state explicitly that email is excluded from Starter
   (§3).

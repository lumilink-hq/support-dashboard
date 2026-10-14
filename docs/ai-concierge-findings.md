# AI Concierge: research findings and working notes

A shared notebook for the AI concierge (talking website avatar / virtual
budtender) scope. It is written to be picked up on either machine: the
LumiLink machine and the PACKS machine both add to it.

- **Brief:** `docs/LumiLink-AI-Concierge-Scope.docx` (Draft 2, 2026-10-15)
- **PACKS in-house build (detail):** `docs/PACKS-AI-Budtender-In-House-Scope.docx`
  (two pages, no appendix). Rebuild it with `python scripts/build-packs-inhouse-scope.py`
- **Summary of the brief:** `docs/ai-concierge-scope-summary.md`
- **Rebuild the brief:** edit the content section of
  `scripts/build-ai-concierge-scope.py`, then run
  `python scripts/build-ai-concierge-scope.py` (needs `pip install python-docx`).
  It prints the word count; the brief stays under 600 words.

**How to collaborate:** add findings under the relevant heading. Date every
entry and tag where it came from (`[LL]` or `[PACKS]`). If a finding changes a number
in the brief, change it in the build script too and note it under §9. Don't
delete someone else's finding; strike it through and say why.

---

## 1. Where things stand

| Item | State |
|---|---|
| Format | One doc. LumiLink add-on scope, with a PACKS "on LL vs in-house" comparison as the last section (decided 2026-10-15) |
| Why the comparison exists | To make the case to leadership that the budtender belongs under LumiLink, with PACKS as client #1, instead of PACKS building and maintaining its own stack. [PACKS 2026-10-15] Kept honest: if PACKS alone comes out better, the docs should show it |
| Recommendation | ~~Build under LL; launch PACKS first~~ [PACKS 2026-10-15] Build under LL if it will be sold to other clients; for PACKS alone both paths cost about the same (see §7) |
| Vendor | Not chosen. Bake-off: HeyGen LiveAvatar vs D-ID |
| Price of the LL add-on | Not set. This is the first question leadership will ask |
| Biggest PACKS unknown | ~~Menu data source after AIQ Dispense is dropped~~ [PACKS 2026-10-15] Resolved: the budtender reads AIQ Dispense's API for now (see §8 Q1). Still open: whether one Dispense key reads all four stores |

## 2. What LumiLink already has (why the LL route is cheap)

Checked in this repo on 2026-10-14:

| Piece | Where | Reuse for the concierge |
|---|---|---|
| ElevenLabs agent + web widget | `components/lumi-widget.tsx`, `app/demo/convai-widget.tsx` | The brain, voice and languages. The avatar replaces the widget's face |
| Knowledge base (crawl, chunk, embed, search) | `supabase/functions/kb-ingest`, `voice-kb-search`; `docs/KNOWLEDGE-BASE.md` | As-is. Embeddings run in the Edge Runtime, so there's no per-embedding bill |
| Product lookup from a Shopify cache | `voice-product-lookup`, `shopify-product-sync`, `products_cache` | Base for a "recommend me something" tool |
| Order lookup with verification | `voice-order-lookup` | Optional |
| Conversation logging | `voice-call-logger`, `/conversations` page | Transcripts for review |
| Restricted-vertical guardrail pattern | `docs/restricted-vertical-compliance.md` | Template for the cannabis profile |
| Signed-URL / private-agent pattern | `docs/shopify-gated-widget-plan.md` §0 | Template for the secure avatar session |

Gotcha already learned (from `shopify-gated-widget-plan.md`): a public
ElevenLabs agent ID in page source can be reused by anyone. The concierge
must use a private agent plus short-lived signed URLs or conversation tokens
minted server-side.

## 3. Avatar vendors

All prices come from third-party roundups, not vendor quotes. The sources
disagree. Accessed 2026-10-14.

| Vendor | Mode | Rate found | Notes |
|---|---|---|---|
| HeyGen LiveAvatar | Face only ("LITE", 1 credit/min) | ~$0.09/min on $99/mo Essential | We bring STT/LLM/voice, which keeps our ElevenLabs agent and guardrails. Essential caps sessions at 20 min, with 20 concurrent. Enterprise claims $0.01/min at scale |
| HeyGen LiveAvatar | Full (2 credits/min) | ~$0.18/min | Their brain, not ours |
| D-ID | Avatar on an existing ElevenLabs agent | Not published | Official quickstart exists. Forum reports: agent endpoint seemed limited to Microsoft voices; one user couldn't use a cloned ElevenLabs voice. May be outdated; verify |
| Anam | Full managed | $0.11-0.16/min, per-second billing | Cheapest managed option; ~5 concurrent on a ~$299 plan |
| Tavus | Full managed | $0.26-0.37/min | Most expensive; 30-sec minimum per conversation; 15 concurrent on $395 plan |
| Simli | Face only | $0.009-0.05/min (sources conflict) | Rendering only; plans visible after signup |

**Why face-only:** a full managed stack would replace our ElevenLabs agent,
which means rebuilding the guardrails, tools, knowledge base and logging inside
the vendor. Face-only keeps everything in section 2 and makes the vendor
swappable.

**Still to get:** custom-avatar creation fee (both vendors), a real streaming
rate from D-ID, and confirmation that D-ID works with our private agent and our
chosen voice.

Sources:
- https://blog.akapulu.com/p/real-time-avatar-api-pricing-index/
- https://www.liveavatar.com/
- https://selviaai.com/heygen-pricing-explained
- https://www.toughtongueai.com/blog/best-virtual-avatar-solutions-2026
- https://docs.d-id.com/docs/elevenlabs-agent
- https://docs.d-id.com/docs/elevenlabs-agent-quickstart
- https://docs.d-id.com/discuss/672aa0a714dfe900746e1348

## 4. Running cost

| Line | Rate | Source |
|---|---|---|
| ElevenLabs agent minutes | $0.08/min on every plan; $0.16/min burst above concurrency | getmacha.com ElevenLabs agents pricing; telnyx.com/pricing/voice-ai |
| LLM tokens | $0.0005-0.0446/min depending on model | Same |
| Avatar, face only | $0.09-0.18/min | Section 3 |
| **All-in** | **$0.18-0.31/min** | 0.08+0.005+0.09 to 0.08+0.045+0.18 |

A 4-minute chat costs $0.70-1.22. Voice-only costs ~$0.085-0.125/min, so video is
about double. That is why per-client minute caps are a day-one feature.

## 5. Build pace evidence (why the hours were cut)

From this repo's git history:

| Build | Scoped | Actual |
|---|---|---|
| SEO product | 173-210 h (`Claude outputs/LumiLink-SEO-Scope.docx`, 2026-09-13) | Foundation committed 2026-09-16, modules 2-20 on 2026-09-22: code done in about a week. First real production run 2026-10-08, after keys, deploys and live fixes |
| Outbound engine | Phases 1, 2, 4 at ~15-23 h (`docs/OUTBOUND-PLAN.md`) | Committed 2026-10-13 between 11:16 and 14:11, with planning before that |

**Rule applied:** code we write ourselves runs 3-5x faster than the
estimates. Vendor waits, live testing on devices and human review barely speed up.
Earlier builds were mostly server-side functions, which compress best. The
concierge's riskiest part is client-side: live video plus mic on mobile
Safari. That's where an overrun would come from.

## 6. Hours, row by row

| Module | Realistic | Original | Reasoning |
|---|---|---|---|
| Vendor bake-off + custom avatar | 6-8 | 8-12 | Hands-on testing of latency, languages and lip sync; waiting on the vendor |
| Website embed | 6-9 | 16-24 | Token route, player, mic permission, text fallback, mobile. Code, but needs real-device testing |
| Audio to lip sync | 3-4 | 8-12 | D-ID has a native path; LiveAvatar LITE takes our audio stream |
| Persona + guardrails + red-team | 7-10 | 10-14 | Prompt is fast; red-team review is human time |
| Store knowledge + recommender | 2-4 | 8-12 | KB and product lookup exist; add one recommendation tool |
| Languages | 3-4 | 4-6 | ElevenLabs config is quick; testing 5 languages is not |
| Dashboard | 4-5 | 14-20 | Settings, kill switch, transcripts, minute caps on existing pages |
| Billing | 1-2 | 6-8 | Add-on pattern exists in `lib/addons.ts` |
| Load + launch QA | 6-8 | 8-10 | Concurrency limits are per vendor plan |
| **LL subtotal** | **38-54** | **82-118** | |
| PACKS launch on LL | 8-14 | 16-24 | Persona, cannabis guardrails, menu feed, branded avatar |

## 7. PACKS: on LL vs in-house

| | On LumiLink | In-house at PACKS |
|---|---|---|
| Build hours | 8-14 after the add-on ships | ~~45-65~~ ~~53-79~~ 48-69 [PACKS 2026-10-15, see below] |
| Monthly upkeep | 1-2 h PACKS-specific; platform upkeep shared | 4-8 h, carried alone |
| Vendor/model change | Fixed once for every client | PACKS fixes its own copy |
| Running cost | Usage + LL add-on fee (TBD) | Usage + its own vendor plans (~$99/mo avatar + ElevenLabs plan) |
| Owner | LL; PACKS sets persona, look, menu | ~~PACKS's developers~~ PACKS's one developer [PACKS 2026-10-15] |

**45-65 derivation:** LL subtotal 38-54, minus billing (1-2) and the multi-client
dashboard (4-5) = 33-47. Add 12-18 to rebuild what PACKS wouldn't inherit:
KB ingest, product sync/lookup, conversation logging, secure token service.

**[PACKS 2026-10-15] Why 45-65 became 53-79:** the 45-65 derivation leaves out the
8-14 h of PACKS-specific setup (cannabis guardrails, 21+ gate, menu feed, store
context), and an in-house build needs that too. It also drops the whole dashboard
row, but in-house still needs a kill switch and minute caps. 45-65 + 8-14 = 53-79.
That's the in-house total. See the next entry for the fair comparison with LL.
An independent bottom-up estimate on the PACKS machine came to 52-78.

**[PACKS 2026-10-15] 53-79 became 48-69:** the detailed in-house scope
(`docs/PACKS-AI-Budtender-In-House-Scope.docx`, built by
`scripts/build-packs-inhouse-scope.py`) estimates bottom-up and finds two shortcuts.
First, an in-house build would use ElevenLabs' built-in knowledge base, not rebuild
`kb-ingest`. Second, PACKS already has a Cloudflare Worker that proxies the Dispense API
(`PACKS_Site\CLOUDFLARE WORKER PROXY AIQ BP\dispense-worker.js`). That Worker keeps the
key on the server and queries all four venues with one key. Is it deployed? Unconfirmed.

**[PACKS 2026-10-15] Fair comparison:** the table's "8-14 after the add-on ships"
leaves out the 38-54 h add-on build itself. If one developer builds either path, the
totals are LL 46-68 vs in-house 48-69, about equal. Platform upkeep (4-8 h/month) is
shared only once LL has other avatar clients. Until then it lands on LL in full. The
LL route also adds an add-on fee (not set) and puts PACKS transcripts in LL's systems.
LL comes out ahead only if it sells the budtender to other clients. Both briefs now
say this; the recommendation is conditional, not "build under LL".

**Upkeep (estimates, not measured):** vendor SDK/model changes, prompt and
guardrail tuning, menu-feed breakages, monitoring, transcript review.

**[PACKS] please check:** does PACKS have its own developers who would own an
in-house build? Is there an existing stack (site platform, hosting) that
changes the 45-65? Is there anything PACKS already pays for that overlaps?

**[PACKS 2026-10-15] Answers:**
- **Own developers:** one. An in-house build and its 4-8 h/month of upkeep would land
  on that one person, which makes it a key-person risk.
- **Existing stack:** packsclub.com is a Shopify theme. A move to Next.js plus Flowhub is
  planned but not started. PACKS already runs a Cloudflare Worker proxy for AIQ, which
  could host an in-house token server. That trims the in-house backend a little; it
  doesn't change the range.
- **Overlap:** PACKS pays for AIQ (CRM/SMS, Dispense menus) and Flowhub (POS). Neither
  includes voice or avatar, so nothing overlaps.

## 8. Open questions

| # | Question | Owner | Answer |
|---|---|---|---|
| 1 | What replaces AIQ Dispense for the menu, and does it have an API with per-store inventory? | PACKS | [PACKS] Nothing yet: the Flowhub Ecomm build hasn't started. Use AIQ Dispense's Blueprint API (`api.dispenseapp.com/2023-03`, `/products` returns `quantityAvailable` per venue). Swapping to the Flowhub Ecomm API (`/v3/products`, `/v3/deals`) later costs 4-6 h if the menu tool sits behind one interface. To confirm: one Dispense key reads all four venues, and the key stays on the server. PACKS's existing Dispense proxy Worker already queries all four venues with one key, which is strong evidence; is it deployed? Unconfirmed |
| 2 | Avatar look, name and personality | PACKS | |
| 3 | Which states, and which cannabis advertising rules apply to an on-site avatar? | PACKS / counsel | [PACKS] California only (SGV, OC, San Bernardino, Hollywood). California cannabis advertising rules apply, plus two-party recording consent and the bot-disclosure law (see §10). Counsel to confirm |
| 4 | How does the avatar know which store the shopper is browsing? | PACKS + LL | [PACKS] The theme's `assets/packs-location-handler.js` already maps store slug to Dispense venue: san-gabriel-valley `998fff4d8f02c2fa`, orange-county `9a0a86a6a5bb3cde`, san-bernardino `537b23523e4ab8cc`, south-los-angeles `e954a82c8f72a4e2` (now Hollywood; never rename the slug or ID). Read the store from the picker or menu path |
| 5 | Add-on price: per month, per minute, or both? | Leadership | |
| 6 | Custom-avatar fee and streaming quote from LiveAvatar and D-ID | LL | |
| 7 | Does the PACKS site platform allow the embed script, mic and video? | PACKS | [PACKS] Shopify theme, so yes: a theme app extension (app embed block) as in `shopify-gated-widget-plan.md` §4. The mic still needs real-device testing on mobile Safari |

Out of scope for both options: the PACKS mobile app (Digital Awesome's build).

## 10. California rules for a voice avatar

[PACKS 2026-10-15] These come from `restricted-vertical-compliance.md` §2, which is written
for peptides, but both points apply to PACKS because every store is in California:

- **Recording consent:** California is a two-party-consent state (Penal Code 632). The
  avatar must disclose recording before the conversation starts.
- **AI disclosure:** California's bot-disclosure law (SB 1001) requires telling the shopper
  they're talking to an AI.
- These sit beside the 21+ gate and the no medical or effect claims rule. Dispense's
  product effect tags must not turn into claims. Counsel confirms all of this before launch.

## 9. Change log

- 2026-10-14 [LL] Draft 1: LL product scope, 82-118 h + 16-24 PACKS.
- 2026-10-14 [LL] Hours cut to realistic pace: 38-54 + 8-14; original kept as ceiling.
- 2026-10-15 [LL] Draft 2: one doc; PACKS on-LL vs in-house comparison added as the last section; this findings file and the build script committed.
- 2026-10-15 [LL] Committed `docs/restricted-vertical-compliance.md` and `docs/shopify-gated-widget-plan.md` so both machines have the guardrail and secure-session templates.
- 2026-10-15 [PACKS] Answered §8 Q1, Q3, Q4, Q7 and the §7 checks (PACKS has one developer). Added §10.
- 2026-10-15 [PACKS] In-house build hours 45-65 → 53-79 (adds the PACKS setup work). Brief: Rules and Risks gains California recording consent and AI disclosure; the PACKS next step becomes testing the Dispense API; Basis bullet corrected to "Outbound phases 1, 2 and 4 took about 3 hours". The build script and the summary were changed to match.
- 2026-10-15 [PACKS] Two docs again: the LL brief stays, and `docs/PACKS-AI-Budtender-In-House-Scope.docx` adds a detailed in-house build (2-page brief plus appendix: hours by row, stack, upkeep breakdown). In-house hours 53-79 → 48-69 in both docs.
- 2026-10-15 [PACKS] Made the comparison like-for-like: LL 46-68 vs in-house 48-69 in total, upkeep shared only once other clients join, add-on fee and data location added. Recommendation is now conditional on LL selling to other clients.
- 2026-10-15 [PACKS] Both docs: removed the reel references; the avatar is described as a realistic AI human from an avatar provider. LL brief gains an example cost row (1,000 four-minute chats: $720-1,240 plus $99). PACKS in-house scope: appendix cut, upkeep breakdown moved into the body; it's now about the same length as the LL brief.

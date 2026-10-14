# AI Concierge (talking website avatar): scope summary

Written 2026-10-14, revised 2026-10-15. The full brief is
`docs/LumiLink-AI-Concierge-Scope.docx` (Draft 2). This file carries the
detail behind it, so the brief can be revised on another machine without the
conversation that produced it.

---

## The ask

Leadership saw an Instagram reel of a virtual budtender: a talking avatar on a
website that answers any question in any language.

**Why LL vs PACKS matters.** Leadership asked for an LL version and a
PACKS-only version so they could weigh one against the other. The case being made is that the
budtender belongs under LumiLink, with PACKS as its first client, instead of
PACKS building and maintaining its own stack. **Decision (2026-10-15): one doc,
with the comparison as its last section,** instead of two separate scopes.

What they asked for: a trained AI with guardrails and a set personality. It works like
our customer-service agent, but it lives on the website as an avatar instead
of a chat widget. They want a customizable avatar from a vendor.

## Architecture

- **Brain, voice, languages:** the existing ElevenLabs agent. It already does
  web conversations (`components/lumi-widget.tsx`), knowledge-base search
  (`kb-ingest`, `voice-kb-search`), product lookup (`voice-product-lookup`,
  fed by `shopify-product-sync`) and order lookup.
- **Face:** a licensed real-time avatar vendor in "face only" mode. It
  lip-syncs to the ElevenLabs audio, so we keep our own guardrails and tools.
- **Security:** the browser gets a short-lived session token minted
  server-side. It never sees a raw agent ID. This uses the same pattern as
  `docs/shopify-gated-widget-plan.md` §0.
- **Guardrails:** a per-client compliance profile in the agent prompt, the same
  approach as `docs/restricted-vertical-compliance.md`.

## Avatar vendors (prices are third-party, not quotes)

| Vendor | Mode | Published rate | Notes |
|---|---|---|---|
| HeyGen LiveAvatar | Face only (LITE) | ~$0.09/min on $99/mo Essential | 20-min session cap on Essential, 20 concurrent |
| D-ID | Face on an ElevenLabs agent | Not published | Has an official ElevenLabs integration; forum reports issues with cloned voices |
| Anam | Full managed stack | $0.11-0.16/min | Would replace our brain; less control |
| Tavus | Full managed stack | $0.26-0.37/min | Most expensive |

Recommendation: compare LiveAvatar and D-ID side by side. Custom-avatar creation fees are unknown and need a quote.

## Hours (realistic pace, from SEO and Outbound history)

SEO was scoped at 173-210 h, and its code shipped in about a week. Outbound phases
1, 2 and 4 (estimated at 15-23 h) were committed in about 3 hours on 2026-10-13. Work we code ourselves
runs 3-5x faster than the estimates. Vendor waits, live tests and human review do not speed up.

| Module | Realistic | Original |
|---|---|---|
| Vendor bake-off and custom avatar | 6-8 | 8-12 |
| Website embed: token, player, mic, text fallback, mobile | 6-9 | 16-24 |
| ElevenLabs audio to avatar lip sync | 3-4 | 8-12 |
| Persona and guardrail profile, red-team set | 7-10 | 10-14 |
| Store knowledge and product-recommendation tool | 2-4 | 8-12 |
| Languages: detection, test top 5 | 3-4 | 4-6 |
| Dashboard: settings, kill switch, transcripts, minute caps | 4-5 | 14-20 |
| Add-on billing, entitlement, pricing page | 1-2 | 6-8 |
| Load, concurrency, launch QA | 6-8 | 8-10 |
| **LumiLink subtotal** | **38-54** | **82-118** |
| PACKS launch on LL (persona, cannabis guardrails, menu feed, branded avatar) | 8-14 | 16-24 |
| **Total** | **46-68** | **98-142** |

Calendar: about 2 weeks. A demo on a stock avatar is possible in 2-3 days. The
custom avatar's delivery sets the launch date. The biggest risk of overrunning
is the mobile Safari embed (live video plus mic), which has to be tested on real phones.

## Running cost per conversation minute

| Line | Type | Amount |
|---|---|---|
| ElevenLabs agent minutes | Variable | $0.08/min |
| LLM tokens | Variable | $0.005-0.045/min |
| Avatar streaming (face only) | Variable | $0.09-0.18/min |
| Avatar vendor plan | Recurring | ~$99/month |
| Custom avatar creation | One-time | Vendor quote, unknown |
| **Total** | | **$0.18-0.31/min; a 4-min chat costs $0.70-1.22** |

That is about double our voice-only cost per minute, so per-client minute caps ship on day one.

## Rules and risks

- **Cannabis:** no medical or effect claims, a 21+ gate before the avatar talks,
  and no sales across state lines. Counsel reviews the guardrail script before
  PACKS goes live.
- **Health data:** customers will describe medical conditions. Transcripts need
  retention limits and a privacy notice.
- **Cost:** video costs about double voice per minute. Cap minutes per client.

## PACKS: on LumiLink or in-house (the comparison in the brief)

Upkeep figures are our estimates, not measured.

| | On the LumiLink stack | Built in-house at PACKS |
|---|---|---|
| Build hours for PACKS | 8-14, after the add-on ships | 45-65 (see below) |
| Monthly upkeep | 1-2 h PACKS-specific; platform upkeep shared | 4-8 h, carried alone |
| Vendor or model change | LL fixes it once for every client | PACKS fixes its own copy |
| Running cost | Per-minute usage plus an LL add-on fee (price TBD) | Same usage plus its own vendor plans |
| Owner | LL; PACKS sets persona, look, menu | PACKS's developers |
| Cost of the choice | Depends on LL's roadmap and pricing | No shared fixes; one client carries all upkeep |

**How 45-65 h was derived:** LL subtotal 38-54, minus billing (1-2) and the
multi-client dashboard (4-5), gives 33-47. Add 12-18 to rebuild what PACKS
would not inherit from LL: knowledge-base ingest, product sync and lookup,
conversation logging and the secure token service.

**In-house upkeep (4-8 h/month)** covers vendor SDK and model changes, prompt
and guardrail tuning, menu-feed breakages, monitoring and transcript review.
On LL, everything except PACKS's persona and menu checks is spread across every client.

## Open items for PACKS

- **Menu data source.** PACKS is leaving AIQ Dispense, which currently runs
  orders at `/menu/<store>`. Recommendations need the new menu's live
  per-store inventory. Confirm what replaces AIQ and whether it has an API.
  This is the biggest unknown in the PACKS hours either way.
- **Avatar look, name and personality:** PACKS brand decision.
- **Per-store context:** the avatar needs to know which store the shopper is browsing.
- **App:** the PACKS mobile app belongs to Digital Awesome. A budtender inside
  it would be their build. Both options cover the website only.
- **Compliance:** state cannabis advertising rules, the 21+ gate, no medical
  claims. Counsel review is a cost line we can't estimate yet.

## Sources

The LumiLink codebase. Akapulu real-time avatar price index (Sept 2026),
liveavatar.com, the D-ID ElevenLabs agent docs and forum, Macha's ElevenLabs agents
pricing, toughtongueai avatar API comparison. Accessed 2026-10-14. Re-check
prices before budgeting.

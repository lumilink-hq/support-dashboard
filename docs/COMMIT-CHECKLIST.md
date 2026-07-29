# Commit Checklist — clearing the backlog on `support-dashboard`

**2026-07-29.** Nothing is committed since `82b11d5 Demo widget restored`. State right now:
**39 modified, 17 untracked, on `main`.**

Read §1 first. The working tree looks far worse than it is, and if you commit it as-is
you'll bury four real changes under 1,428 lines of noise — permanently.

Every command below is safe to read first; nothing here has been run for you.

---

## §1 — The headline: 35 of the 39 "modified" files have no real changes

`git diff --stat` on the migrations shows **1,428 insertions and 1,428 deletions** — exactly
equal, across every file. That's the signature of a **line-ending change**, not an edit.

Confirmed:

```
$ git diff --stat --ignore-cr-at-eol -- supabase/migrations/ supabase/seed*.sql
(empty)
```

Zero real change in **any** applied migration. `0001`, `0002`, `0005`, `0008`, `seed.sql`,
`seed_clients.sql` are byte-identical apart from CRLF. **This is a relief** — editing an
already-applied migration is the thing that quietly desyncs your local files from the
deployed schema, and it turns out nobody did.

Across the whole tree, only **four** files have real changes:

| File | Real lines | Origin |
|---|---|---|
| `supabase/functions/voice-order-lookup/index.ts` | 457 | today (Shopify + slug routing) |
| `supabase/functions/voice-call-logger/index.ts` | 44 | earlier session |
| `docs/scheduling-agent-prompt.md` | 57 | earlier session |
| `supabase/functions/voice-call-logger/lib.ts` | 4 | earlier session |

### Why it happened, and why it'll keep happening

```
core.autocrlf → (unset)
.gitattributes → does not exist
```

Windows tools write CRLF, git faithfully stores it, and nothing normalizes. Worse, the files
**I** wrote from the Linux container are LF:

```
0001_init_schema.sql          → CRLF line terminators
0012_voice_usage_caps.sql     → (LF)
voice-order-lookup/lib.ts     → (LF)
```

So the repo is one commit away from **mixed** line endings, which is worse than consistently
either one. Fix it before the commit, not after.

- [ ] **1.1 Add `.gitattributes`** at the repo root:
      ```gitattributes
      # Normalize everything to LF in the repository; check out native on Windows.
      * text=auto eol=lf

      # Binary — never touch, never diff as text.
      *.xlsx  binary
      *.docx  binary
      *.png   binary
      *.ico   binary
      *.pdf   binary
      ```
- [ ] **1.2 Discard the 35 files of pure noise.** They have no content changes, so throwing
      the working copies away loses nothing:
      ```bash
      # 1. See the REAL list first — confirm it's the 4 files in the table above.
      git diff --ignore-cr-at-eol --name-only

      # 2. Restore everything that ISN'T in that list.
      git diff --name-only > /tmp/all.txt
      git diff --ignore-cr-at-eol --name-only > /tmp/real.txt
      comm -23 <(sort /tmp/all.txt) <(sort /tmp/real.txt) | tr '\n' '\0' | xargs -0 git checkout --
      ```
      > ⚠️ `git checkout --` is destructive. Run step 1 and eyeball the output before step 2.
      > If the real list has anything beyond those four files, stop and tell me.
- [ ] **1.3 Re-check.** `git status --porcelain` should now show ~4 modified files, not 39.

---

## §2 — Housekeeping before anything gets staged

- [ ] **2.1 `supabase/.temp/` is tracked and shouldn't be.** Two pgdelta catalog JSONs
      (1.8 MB each) are in git history and show as modified on every run:
      ```bash
      echo "supabase/.temp/" >> .gitignore
      git rm -r --cached supabase/.temp/
      ```
- [ ] **2.2 `_to_delete/` must not be committed.** It's the parking folder from a previous
      session (I can't delete files on your machine, only move them there). Either delete it
      in Explorer or add it to `.gitignore` — but don't commit it.
- [ ] **2.3 Decide on `docs/LumiLink_CFO_Financial_Hub.xlsx`.** 103 KB binary containing your
      pricing, margins, and labor rates. Fine in a private repo; think twice if this repo
      ever gets shared with a client or goes public. `.gitattributes` above already marks it
      binary so it won't produce garbage diffs.
- [ ] **2.4 `.env.local` is safely ignored** — verified (`.gitignore:34:.env*`). No action.
- [ ] **2.5 Scan the staged diff for secrets** before the first commit, since Shopify tokens
      and service-role keys have been moving around today:
      ```bash
      git diff --cached | grep -nE 'shpat_|shpss_|sk-|eyJhbGciOi|service_role|SUPABASE_SECRET' || echo "clean"
      ```
      Placeholders like `shpat_…` in the docs are fine; a real 32-char token is not.

---

## §3 — Verify before committing

- [ ] **3.1** `npx tsx scripts/test-voice-lookup-shopify.ts` → **141 checks, all green**
- [ ] **3.2** `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test_voice_usage_caps.sql`
      → `ALL VOICE CAP TESTS PASSED` + `ALL TENANT ISOLATION TESTS PASSED`
      (it rolls itself back; run against staging/shadow, not prod, if you'd rather)
- [ ] **3.3** `npm run build` (or `pnpm build`) — the dashboard still compiles
- [ ] **3.4** `npx tsc --noEmit` if that's wired up

> Note on my own testing: I verified `0012` against a **local** Postgres built from your
> committed migrations. That's now known-safe, because §1 proved the migration files are
> unedited — but it does assume the deployed database matches them. If you've ever applied a
> hotfix straight in the Supabase SQL editor, `supabase db diff` is worth running once.

---

## §4 — Branch first

You're on `main`.

- [ ] **4.1** `git checkout -b voice/tsunami-orders`

---

## §5 — Suggested commits

Small commits, in this order. Line-ending infrastructure goes first so everything after it is
clean.

- [ ] **5.1 `chore: normalize line endings and ignore supabase/.temp`**
      `.gitattributes`, `.gitignore`, `git rm --cached supabase/.temp/`
- [ ] **5.2 `feat(voice): Shopify order lookup with slug routing and caller verification`**
      ```
      supabase/functions/voice-order-lookup/lib.ts      (new)
      supabase/functions/voice-order-lookup/index.ts    (modified)
      scripts/test-voice-lookup-shopify.ts              (new)
      scripts/fetch-shopify-policies.mjs                (new)
      ```
- [ ] **5.3 `feat(limits): per-client voice usage metering and hard caps (0012)`**
      ```
      supabase/migrations/0012_voice_usage_caps.sql     (new)
      scripts/test_voice_usage_caps.sql                 (new)
      ```
      Worth putting in the commit body: the views use `security_invoker` deliberately —
      `0001`'s default privileges auto-grant `authenticated` on every new table *and view*,
      and a plain view would bypass RLS.
- [ ] **5.4 `feat(voice): call-logger transcript and escalation fixes`**
      `voice-call-logger/{index.ts,lib.ts}` — from an earlier session. **Skim the 44-line
      diff before committing**; it predates today and I haven't reviewed it.
- [ ] **5.5 `docs: voice orders plan, limits, CFO inputs, web demo checklist`**
      all of `docs/*.md` + the xlsx + `docs/elevenlabs-tools/`
- [ ] **5.6 `chore(demo): demo page assets`**
      `demo/` (root folder, contains `index.html`)

---

## §6 — After committing

- [ ] **6.1** Push the branch; PR into `main` if you want the diff reviewable in one place.
- [ ] **6.2** Railway rebuild for the dashboard.
- [ ] **6.3** `supabase db push` — applies `0012`.
- [ ] **6.4** `supabase functions deploy voice-order-lookup --no-verify-jwt`.
- [ ] **6.5** Nothing else is deployed by this batch. The pre-call gate, the ticket system,
      and the staleness fix are all still unbuilt.

---

## §7 — Two things I noticed while in here

**`docs/elevenlabs-tools/` has six tool definitions — all scheduling, none for orders.**
`book_appointment`, `cancel_appointment`, `capture_lead`, `check_availability`,
`find_appointment`, `reschedule_appointment`. There's no `lookup_order.json`. When you wire
the orders agent you'll be adding `client_ref`, `verify_email`, and `verify_zip` parameters —
worth landing a matching JSON in that folder so the tool schema is version-controlled like
the others, rather than living only in the ElevenLabs UI.

**`demo/index.html` at the repo root** is separate from `app/demo/page.tsx`. If that's the
standalone widget page, it's the natural starting point for the tsunami.store embed — worth
knowing which of the two you're planning to build on.

---

## Not done, deliberately

I've run only read-only git commands (`--no-optional-locks`). Nothing is staged, branched, or
committed. Also worth knowing: **git writes fail from this session** (`.git/index.lock`,
"Operation not permitted"), so the commits themselves have to happen in your terminal.

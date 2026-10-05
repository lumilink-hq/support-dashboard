@AGENTS.md

# LumiLink support-dashboard

One Next.js app serving both the marketing site and the client dashboard, deployed on Railway at
`https://www.lumilinkhub.com`. Backend is Supabase (Postgres migrations in `supabase/migrations/`,
Deno edge functions in `supabase/functions/`). Billing is Stripe.

## Commands

- `npm run check` — typecheck + JSX missing-space check (`check:jsx`) + every unit test. Run before calling a change done.
- `npm test` / `npm test -- seo` — the `scripts/test-*.ts` unit tests (all, or names containing "seo").
- `npm run test:sql` — the `scripts/test_*.sql` tests against the **local** db container. Each test
  rolls itself back. Needs `npx supabase start` first.
- `node scripts/check-migration-sql.mjs [prefix]` — syntax-check migrations before any push.
- `npm run lint` — currently fails on existing `no-explicit-any` debt; don't treat it as a gate.
- Package manager is **pnpm** (`pnpm-lock.yaml` is what Railway builds from). Don't create a `package-lock.json`.

## Environments — read before running anything

- `.env.local` holds **production** values. `next dev` with no overrides talks to the live database.
  Never put a value meant only for production in it, and never test signed-in flows against it.
- Local stack: `npx supabase start` (Docker), DB container `supabase_db_support-dashboard`.
  Browser preview: use the `support-dashboard-local` config in the root `.claude/launch.json`
  (port 3100, local Supabase URL/keys). `support-dashboard-dev` (port 3000) is production data.
- If signed-in `(dashboard)` routes all 404 instantly in dev, delete `.next/dev` and restart.

## Deploying

- Edge functions: **always** `supabase functions deploy <name> --no-verify-jwt`. Every function
  authenticates with the shared-secret header (`x-voice-tool-secret`), not Supabase's JWT gateway.
  Without the flag the deploy succeeds and then every scheduled call silently 401s. Confirm with
  `supabase functions list` (`verify_jwt` should be false).
- `supabase db push`, `functions deploy` and `secrets set` hit the linked **production** project.

## Project docs

- `../plan.md` (outside this repo) is the SEO build plan. Update its module row as work lands, and
  add setup / live-test items to §8 as each module is built.
- `docs/PROJECT-STATUS.md` is an older handover doc; it is not the source of truth for SEO status.

# seo-render-service

Module 6's headless-browser fallback (`plan.md`: "a JavaScript-rendered
site... writes one critical finding... Railway headless-browser fallback
not built"). A small, standalone HTTP service that renders one URL with a
real headless Chromium and returns the resulting HTML — called by
`supabase/functions/seo-crawl` only when a plain `fetch` of a site's root
page looks JS-rendered (almost no visible text).

It is **not** part of the Next.js app or the Supabase edge functions: it
needs a real browser binary, which neither of those runtimes carries, so it
is deployed as its **own Railway service**, built from this directory.

## Deploying to Railway

1. In the Railway project that already hosts the dashboard, **add a new
   service** ("Empty Service" / "Deploy from repo") pointed at this same
   repo, with **Root Directory** set to `render-service`. Railway will build
   it from `render-service/Dockerfile`.
2. Set these variables on the **new service**:
   - `RENDER_SERVICE_SECRET` — a long random string. Put the same value in
     Supabase (`supabase secrets set RENDER_SERVICE_SECRET=…`), because
     `seo-crawl` sends it as `x-render-secret` on every call.
   - `MAX_CONCURRENT_RENDERS` (optional, default `2`) — raise it only if the
     plan has the memory; each render holds a real browser context.
3. Health check path: `/healthz` (Railway's default health check settings
   work with this — it returns `200` once the browser has launched).
4. Once deployed, copy the service's public URL and set it on the
   **Supabase** side:
   ```
   supabase secrets set RENDER_SERVICE_URL=https://<this-service>.up.railway.app/render
   supabase secrets set RENDER_SERVICE_SECRET=<the same secret from step 2>
   ```
   Then redeploy `seo-crawl` so it picks up the new secrets:
   ```
   supabase functions deploy seo-crawl --no-verify-jwt
   ```

Until both `RENDER_SERVICE_URL` and `RENDER_SERVICE_SECRET` are set on the
Supabase side, `seo-crawl` behaves exactly as it did before this service
existed: a JS-rendered site gets the "can't audit" critical finding, not a
silent failure.

## What it does and doesn't do

- Only ever called by `seo-crawl`, behind the shared secret, with the
  client's own `seo_locations.website_url` — never a public,
  unauthenticated endpoint for arbitrary URLs.
- Refuses non-`http(s)` URLs and hosts that are already private-shaped
  (`localhost`, a raw IP literal, `.local`/`.localhost`) — see
  `src/ssrf-guard.ts` for exactly what that does and doesn't cover (no DNS
  resolution, so no defense against DNS rebinding; not needed for this
  service's narrow, first-party call path — see that file's header).
- Renders **one page per call** (the root page only — `seo-crawl` still
  fetches subsequent pages plainly, not rendered, to keep cost and latency
  down). A subpage that's still a JS shell falls through to the ordinary
  thin-content finding rather than a second render.
- Images, fonts and media are blocked during the render (faster, and this
  service only ever reads the resulting DOM's text/markup, never a
  screenshot).
- One shared Chromium instance per running container, launched at startup;
  a crash triggers a lazy relaunch on the next request. A concurrency limit
  (`MAX_CONCURRENT_RENDERS`) returns `503` rather than queueing forever.

## Local development

```bash
npm install
npm test      # pure unit tests (src/ssrf-guard.ts) — no browser needed
npm run dev   # runs directly with tsx; needs `npx playwright install chromium` first
```

To test the real Docker image (what Railway actually runs):

```bash
docker build -t seo-render-service:local .
docker run -p 8080:8080 -e RENDER_SERVICE_SECRET=dev-secret seo-render-service:local
curl -X POST http://localhost:8080/render \
  -H "x-render-secret: dev-secret" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

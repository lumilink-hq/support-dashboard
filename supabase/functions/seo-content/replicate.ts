// =============================================================================
// seo-content/replicate.ts — module 16 (plan.md): image generation through
// Replicate, Flux only (decision 2026-09-21: no OpenAI). `fetch` and `sleep` are
// injected so scripts/test-seo-content.ts drives it with a fake and no network.
//
// TIERS (plan.md: "Flux Schnell for standard posts, Flux Dev for premium pages"):
//   standard -> black-forest-labs/flux-schnell
//   premium  -> black-forest-labs/flux-dev
// Articles use 'standard'. 'premium' is here for module 5/16's premium pages.
//
// LICENSING. FLUX.1 [dev]'s own licence is non-commercial, but Replicate has an
// arrangement that lets images generated THROUGH ITS API be used commercially
// (source: search of Replicate's and Black Forest Labs' pages, 2026-09-21; the
// full text wasn't fetched). That holds only for inference on Replicate: don't
// move this model elsewhere without re-checking. Flux Schnell is Apache-2.0.
// Confirm against Replicate's current terms before selling premium images.
//
// SAFETY. The model's safety checker is left ON (disable_safety_checker is never
// sent). A blocked prompt comes back as a failed prediction, surfaced here as a
// 'safety' error; the caller ships the article without an image instead of
// retrying the same prompt. plan.md still owes a quality and moderation test on
// real LumiLink content.
//
// OUTPUT FILES ARE NOT KEPT FOREVER. Replicate's docs excerpt didn't state a
// retention period, so the caller downloads the bytes immediately (downloadImage)
// and stores them itself; the returned URL is never saved.
//
// RULE 6: exponential backoff on 429/5xx/network, honouring Retry-After.
// =============================================================================

export type ImageTier = "standard" | "premium";

export const MODELS: Record<ImageTier, string> = {
  standard: "black-forest-labs/flux-schnell",
  premium: "black-forest-labs/flux-dev",
};

export type ReplicateErrorKind =
  | "auth" // 401/403
  | "invalid" // 422: the input was rejected
  | "safety" // the safety checker refused
  | "failed" // the prediction failed for another reason
  | "timeout" // still running after we stopped waiting
  | "transient" // network / 5xx / 429 after retries
  | "bad_output"; // it "succeeded" but gave no usable image

export class ReplicateError extends Error {
  constructor(public kind: ReplicateErrorKind, message: string) {
    super(message);
    this.name = "ReplicateError";
  }
}

export type Ctx = {
  token: string;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  maxRetries?: number; // default 4
  baseDelayMs?: number; // default 1000
  maxDelayMs?: number; // default 30_000
  pollIntervalMs?: number; // default 2000
  maxPollMs?: number; // default 90_000
};

const API = "https://api.replicate.com/v1";

/** 16:9 suits a blog hero image and Shopify's article layout. */
export function buildInput(tier: ImageTier, prompt: string): Record<string, unknown> {
  const common = { prompt, aspect_ratio: "16:9", num_outputs: 1, output_format: "webp", output_quality: 85 };
  return tier === "premium"
    ? { ...common, guidance: 3, num_inference_steps: 28 }
    : { ...common, go_fast: true };
}

function backoff(attempt: number, ctx: Ctx, retryAfter: string | null): number {
  const base = ctx.baseDelayMs ?? 1000;
  const max = ctx.maxDelayMs ?? 30_000;
  const computed = Math.min(base * 2 ** attempt, max);
  const ra = retryAfter ? Number(retryAfter) * 1000 : NaN;
  return Number.isFinite(ra) ? Math.min(Math.max(ra, computed), max) : computed;
}

type Prediction = {
  status?: string;
  output?: unknown;
  error?: string | null;
  urls?: { get?: string };
};

/** One HTTP call with retry. Returns the parsed body; throws ReplicateError. */
async function call(ctx: Ctx, url: string, init: RequestInit): Promise<Prediction> {
  const max = ctx.maxRetries ?? 4;
  let last = "";
  for (let attempt = 0; attempt <= max; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, init);
    } catch (e) {
      last = `network error: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt < max) await ctx.sleep(backoff(attempt, ctx, null));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ReplicateError("auth", `Replicate rejected the token (${res.status})`);
    if (res.status === 422) {
      const body = await res.text().catch(() => "");
      throw new ReplicateError("invalid", `Replicate rejected the input: ${body.slice(0, 300)}`);
    }
    if (res.status === 429 || res.status >= 500) {
      last = `HTTP ${res.status}`;
      if (attempt < max) await ctx.sleep(backoff(attempt, ctx, res.headers.get("Retry-After")));
      continue;
    }
    if (!res.ok) throw new ReplicateError("failed", `Replicate returned HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as Prediction | null;
    if (!body) {
      last = "unparseable response";
      if (attempt < max) await ctx.sleep(backoff(attempt, ctx, null));
      continue;
    }
    return body;
  }
  throw new ReplicateError("transient", `gave up after ${max + 1} attempts: ${last}`);
}

function failure(p: Prediction): ReplicateError {
  const msg = String(p.error ?? "the prediction failed");
  return /nsfw|safety|flagged|sensitive/i.test(msg) ? new ReplicateError("safety", msg) : new ReplicateError("failed", msg);
}

function urlFrom(output: unknown): string | null {
  const first = Array.isArray(output) ? output[0] : output;
  return typeof first === "string" && /^https:\/\//.test(first) ? first : null;
}

/**
 * Render one image. `Prefer: wait` makes Replicate hold the request until the
 * prediction finishes (up to 60s), which is normally enough for Flux; if it
 * doesn't, poll the prediction's own URL.
 */
export async function generateImage(ctx: Ctx, tier: ImageTier, prompt: string): Promise<{ url: string; model: string }> {
  const model = MODELS[tier];
  const auth = { Authorization: `Bearer ${ctx.token}` };

  let p = await call(ctx, `${API}/models/${model}/predictions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Prefer: "wait=60" },
    body: JSON.stringify({ input: buildInput(tier, prompt) }),
  });

  const interval = ctx.pollIntervalMs ?? 2000;
  const budget = ctx.maxPollMs ?? 90_000;
  let waited = 0;
  while (p.status === "starting" || p.status === "processing") {
    if (!p.urls?.get) throw new ReplicateError("bad_output", "prediction has no status URL to poll");
    if (waited >= budget) throw new ReplicateError("timeout", `still ${p.status} after ${Math.round(budget / 1000)}s`);
    await ctx.sleep(interval);
    waited += interval;
    p = await call(ctx, p.urls.get, { method: "GET", headers: auth });
  }

  if (p.status === "failed" || p.status === "canceled") throw failure(p);
  if (p.status !== "succeeded") throw new ReplicateError("bad_output", `unexpected status "${p.status}"`);

  const url = urlFrom(p.output);
  if (!url) throw new ReplicateError("bad_output", "the prediction succeeded but returned no image URL");
  return { url, model };
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Copy the finished image out of Replicate. The URL is not saved anywhere. */
export async function downloadImage(ctx: Pick<Ctx, "fetch">, url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  let res: Response;
  try {
    res = await ctx.fetch(url);
  } catch (e) {
    throw new ReplicateError("transient", `image download failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ReplicateError("transient", `image download returned HTTP ${res.status}`);
  const contentType = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!/^image\/(webp|png|jpeg)$/.test(contentType)) throw new ReplicateError("bad_output", `unexpected content type "${contentType}"`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new ReplicateError("bad_output", "the downloaded image was empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ReplicateError("bad_output", `the image is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES} limit`);
  return { bytes, contentType };
}

export function extensionFor(contentType: string): string {
  return contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "webp";
}

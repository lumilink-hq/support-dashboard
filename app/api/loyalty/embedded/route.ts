import { NextResponse } from "next/server";
import { z } from "zod";
import { bearer } from "@/lib/loyalty-embedded/session-token";
import { ACTION_NAMES, EmbeddedError, ensureInstalled, runAction, verifyRequest } from "@/lib/services/loyalty-embedded";

// LL Loyalty embedded admin API (0225). Called by public/embedded/app.js
// inside Shopify admin with the App Bridge session token as a Bearer token.
// The token is the only authentication: see lib/services/loyalty-embedded.ts.

const bodySchema = z.object({
  action: z.string().refine((a) => ACTION_NAMES.includes(a), "unknown action"),
  args: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(request: Request) {
  const token = bearer(request.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const { session, app } = await verifyRequest(token);
    if (parsed.data.action === "load") await ensureInstalled(token, session, app);
    const data = await runAction(session, parsed.data.action, parsed.data.args);
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof EmbeddedError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error(`loyalty embedded: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

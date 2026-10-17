import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";
import { peekSession, verifyAdminSession, type AdminSession } from "@/lib/loyalty-embedded/session-token";

// LL Loyalty embedded admin (0225, Phase 2 P4): the merchant's admin inside
// Shopify admin. There is no LumiLink login there, so this is the one place
// the loyalty admin runs on the service role:
//   1. the Shopify session token is verified with the app's secret
//      (session-token.ts) - nothing is done for an unverified request
//   2. the store is installed on first open by token exchange, if needed
//   3. each action is a fixed RPC from ACTIONS, called with the service role
//      and the x-ll-embedded-shop / -user headers. The RPCs themselves decide
//      (loyalty_require_manager): only the program of that shop, only with
//      merchant_access on. The program id always comes from the shop, never
//      from the browser.

const API_VERSION = "2026-10";
const SHOP_BASE = (process.env.SHOPIFY_SHOP_BASE ?? "").replace(/\/+$/, ""); // test only: mock store

type AppRow = { app_client_id: string; credentials: string | null };
type App = { clientId: string; clientSecret: string };

export class EmbeddedError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function parseCreds(raw: string | null): App | null {
  try {
    const j = JSON.parse(raw ?? "") as { client_id?: string; client_secret?: string };
    return j.client_id && j.client_secret ? { clientId: j.client_id, clientSecret: j.client_secret } : null;
  } catch {
    return null;
  }
}

function adminUrl(shop: string, path: string): string {
  return SHOP_BASE ? `${SHOP_BASE}/${shop}/admin/${path}` : `https://${shop}/admin/${path}`;
}

/** The app the token claims to be for, if it's registered for the shop or self-serve. */
async function appFor(service: SupabaseClient, shop: string, clientId: string): Promise<App | null> {
  const [reg, self] = await Promise.all([
    service.rpc("get_loyalty_shopify_apps", { p_shop: shop }),
    service.rpc("get_loyalty_self_serve_apps"),
  ]);
  if (reg.error || self.error) throw new Error(`loading apps failed: ${(reg.error ?? self.error)!.message}`);
  const rows = [...((reg.data ?? []) as AppRow[]), ...((self.data ?? []) as AppRow[])];
  for (const row of rows) {
    if (row.app_client_id !== clientId) continue;
    const creds = parseCreds(row.credentials);
    if (creds && creds.clientId === clientId) return creds;
  }
  return null;
}

export async function verifyRequest(token: string): Promise<{ session: AdminSession; app: App }> {
  const peek = peekSession(token);
  if (!peek) throw new EmbeddedError(401, "bad_token");
  const service = createServiceClient();
  const app = await appFor(service, peek.shop, peek.clientId);
  if (!app) throw new EmbeddedError(401, "unknown_app");
  const v = verifyAdminSession(token, app.clientId, app.clientSecret, Math.floor(Date.now() / 1000));
  if (!v.ok) throw new EmbeddedError(401, v.reason);
  return { session: { shop: v.shop, userId: v.userId, clientId: v.clientId }, app };
}

/**
 * First open of an embedded app on a store: exchange the session token for an
 * offline token and install (loyalty_install, same as loyalty-oauth). Non-
 * expiring tokens: fine for custom apps. NOT for the public app - see plan P6.
 */
export async function ensureInstalled(token: string, session: AdminSession, app: App): Promise<void> {
  const service = createServiceClient();
  const { data, error } = await service
    .from("loyalty_shopify_apps")
    .select("token_ref")
    .eq("shop_domain", session.shop)
    .eq("app_client_id", app.clientId)
    .maybeSingle();
  if (error) throw new Error(`loading install state failed: ${error.message}`);
  if (data?.token_ref) return;

  const res = await fetch(adminUrl(session.shop, "oauth/access_token"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: token,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string };
  if (res.status !== 200 || !j.access_token) throw new EmbeddedError(502, `token exchange failed (${res.status})`);

  let name: string | null = null;
  let timezone: string | null = null;
  try {
    const shopRes = await fetch(adminUrl(session.shop, `api/${API_VERSION}/graphql.json`), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": j.access_token },
      body: JSON.stringify({ query: "query LoyaltyInstallShop { shop { name ianaTimezone } }" }),
    });
    const s = ((await shopRes.json()) as { data?: { shop?: { name?: string; ianaTimezone?: string } } }).data?.shop;
    name = s?.name ?? null;
    timezone = s?.ianaTimezone ?? null;
  } catch {
    // defaults in SQL
  }
  const install = await service.rpc("loyalty_install", {
    p_shop: session.shop,
    p_app_client_id: app.clientId,
    p_access_token: j.access_token,
    p_scopes: j.scope ? j.scope.split(",") : null,
    p_shop_name: name,
    p_timezone: timezone,
  });
  if (install.error) throw new EmbeddedError(500, `install failed: ${install.error.message}`);
}

/** Service-role client that tells the RPCs who is acting (0225 headers). */
function actorClient(session: AdminSession): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-ll-embedded-shop": session.shop, "x-ll-embedded-user": session.userId } },
  });
}

type Args = Record<string, unknown>;
const ACTIONS: Record<string, { rpc: string; args: (programId: string, a: Args) => Args }> = {
  save_settings: { rpc: "loyalty_staff_program_save", args: (p, a) => ({ p_program: p, p_settings: a.settings ?? {} }) },
  save_tiers: { rpc: "loyalty_staff_tiers_save", args: (p, a) => ({ p_program: p, p_tiers: a.tiers ?? [] }) },
  save_reward: { rpc: "loyalty_staff_reward_save", args: (p, a) => ({ p_program: p, p_reward: a.reward ?? {} }) },
  save_earn_rule: {
    rpc: "loyalty_staff_earn_rule_save",
    args: (p, a) => ({ p_program: p, p_key: String(a.key ?? ""), p_points: Number(a.points), p_active: a.active === true }),
  },
};

// Member actions return only their own data, not the whole program. The
// member id comes from the browser: each RPC checks it belongs to the shop.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTER_KEYS = ["q", "tier", "status", "group", "can_redeem", "demotes_30d", "expires_30d"];

function memberId(a: Args): string {
  const id = String(a.member ?? "");
  if (!UUID.test(id)) throw new EmbeddedError(400, "bad_member");
  return id;
}

const MEMBER_ACTIONS: Record<string, { rpc: string; args: (programId: string, a: Args) => Args; then?: "member" }> = {
  members: {
    rpc: "loyalty_staff_members",
    args: (p, a) => {
      const raw = (a.filters ?? {}) as Record<string, unknown>;
      const filters: Record<string, unknown> = {};
      for (const k of FILTER_KEYS) if (raw[k] !== undefined && raw[k] !== "" && raw[k] !== false) filters[k] = raw[k];
      return { p_program: p, p_filters: filters, p_sort: String(a.sort ?? "points"), p_dir: String(a.dir ?? "desc"), p_page: Math.max(Number(a.page) || 1, 1) };
    },
  },
  member: { rpc: "loyalty_staff_member", args: (_p, a) => ({ p_member: memberId(a) }) },
  adjust: {
    rpc: "loyalty_staff_adjust",
    args: (_p, a) => ({ p_member: memberId(a), p_points: Number(a.points), p_note: String(a.note ?? ""), p_request_key: String(a.request_key ?? "") }),
    then: "member",
  },
  set_tier: {
    rpc: "loyalty_staff_set_tier",
    args: (_p, a) => ({ p_member: memberId(a), p_tier_key: String(a.tier ?? ""), p_note: String(a.note ?? "") }),
    then: "member",
  },
  set_birthday: {
    rpc: "loyalty_staff_set_birthday",
    args: (_p, a) => ({ p_member: memberId(a), p_birthday: a.birthday ? String(a.birthday) : null, p_note: String(a.note ?? "") }),
    then: "member",
  },
};

export const ACTION_NAMES = ["load", ...Object.keys(ACTIONS), ...Object.keys(MEMBER_ACTIONS)];

/**
 * load: program + plan + config. A config save: one RPC from ACTIONS, then a
 * fresh load. A member action: its RPC only (plus the member after a change).
 */
export async function runAction(session: AdminSession, action: string, args: Args): Promise<Record<string, unknown>> {
  const db = actorClient(session);
  const prog = await db.rpc("loyalty_embedded_program");
  if (prog.error) throw new Error(`loading program failed: ${prog.error.message}`);
  const program = prog.data as { id: string } | null;
  if (!program) throw new EmbeddedError(403, "no_access");

  const m = MEMBER_ACTIONS[action];
  if (m) {
    const r = await db.rpc(m.rpc, m.args(program.id, args));
    if (r.error) throw new EmbeddedError(r.error.message === "not_staff" ? 403 : 400, r.error.message);
    if (m.then !== "member") return { result: r.data };
    const detail = await db.rpc("loyalty_staff_member", { p_member: memberId(args) });
    if (detail.error) throw new EmbeddedError(400, detail.error.message);
    return { result: r.data, member: detail.data };
  }

  let result: unknown = null;
  if (action !== "load") {
    const a = ACTIONS[action];
    if (!a) throw new EmbeddedError(400, "unknown_action");
    const r = await db.rpc(a.rpc, a.args(program.id, args));
    if (r.error) throw new EmbeddedError(r.error.message === "not_staff" ? 403 : 400, r.error.message);
    result = r.data;
  }
  const [plan, config] = await Promise.all([
    db.rpc("loyalty_staff_plan", { p_program: program.id }),
    db.rpc("loyalty_staff_program_config", { p_program: program.id }),
  ]);
  if (plan.error || config.error) throw new Error(`loading failed: ${(plan.error ?? config.error)!.message}`);
  return { program: prog.data, plan: plan.data, config: config.data, result };
}

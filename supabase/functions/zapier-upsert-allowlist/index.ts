import { createClient } from "npm:@supabase/supabase-js@2.49.1";

type ZapierClientUpsert = {
  table: string;
  // For this function, client lookup uses clients.support_email
  // so callers must provide keys via `values.support_email` (recommended) or `email`.
  email?: string;
  keys?: { id?: string };
  values: Record<string, unknown>;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_DB_URL = Deno.env.get("SUPABASE_DB_URL"); // used only to validate env
const rawSecrets = Deno.env.get("SUPABASE_SECRET_KEYS");

if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
if (!SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL is required");
if (!rawSecrets) throw new Error("SUPABASE_SECRET_KEYS is required");

const secretKeys = JSON.parse(rawSecrets) as Record<string, string>;
const SERVICE_ROLE_SECRET = secretKeys["default"];
if (!SERVICE_ROLE_SECRET) {
  throw new Error(
    "Missing service role secret key: SUPABASE_SECRET_KEYS['default'] not found.",
  );
}

// Strict allowlist
const ALLOWED_TABLES = new Set([
  "clients",
  "conversations",
  "messages",
  "orders_cache",
  "review_queue",
]);

const CLIENT_LOOKUP_EMAIL_COLUMN = "support_email";
const CLIENT_STORE_PLATFORM_COLUMN = "store_platform";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Connection": "keep-alive",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: ZapierClientUpsert;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { table, values } = body ?? ({} as ZapierClientUpsert);

  if (!table || !ALLOWED_TABLES.has(table)) {
    return jsonResponse({ error: "Table not allowed" }, 400);
  }

  if (!values || typeof values !== "object") {
    return jsonResponse({ error: "Missing values (object)" }, 400);
  }

  // 1) Always determine client id by support_email first.
  // Prefer explicit body.email, else use values.support_email.
  const emailFromBody = body.email;
  const emailFromValues = values[CLIENT_LOOKUP_EMAIL_COLUMN];
  const email =
    (typeof emailFromBody === "string" ? emailFromBody : undefined) ??
    (typeof emailFromValues === "string" ? emailFromValues : undefined);

  if (!email) {
    return jsonResponse(
      {
        error: `Missing client email. Provide body.email or values.${CLIENT_LOOKUP_EMAIL_COLUMN}.`,
      },
      400,
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_SECRET, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Ensure store_platform required on client create/upsert.
  if (table === "clients") {
    const storePlatform = values[CLIENT_STORE_PLATFORM_COLUMN];
    if (typeof storePlatform !== "string" || storePlatform.length === 0) {
      return jsonResponse(
        { error: `Missing required values.${CLIENT_STORE_PLATFORM_COLUMN}` },
        400,
      );
    }
  }

  // Look for existing client row.
  const { data: existingClient, error: lookupError } = await supabase
    .from("clients")
    .select("id")
    .eq(CLIENT_LOOKUP_EMAIL_COLUMN, email)
    .maybeSingle();

  if (lookupError) {
    return jsonResponse({ error: lookupError.message }, 400);
  }

  const clientId = existingClient?.id;

  // If caller is upserting clients, upsert on client primary key id (found by email) or insert.
  if (table === "clients") {
    const upsertValues: Record<string, unknown> = { ...values };
    // Always set support_email from lookup email.
    upsertValues[CLIENT_LOOKUP_EMAIL_COLUMN] = email;
    if (clientId) upsertValues.id = clientId;

    const { data, error } = await supabase
      .from("clients")
      .upsert(upsertValues, { onConflict: "id" })
      .select();

    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ ok: true, table, client_id: data?.[0]?.id ?? clientId });
  }

  // For other tables, require clientId so we can relate them.
  if (!clientId) {
    return jsonResponse(
      {
        error:
          "No client found for this support_email. First upsert the clients row (table=clients) so conversations/messages/etc can reference it.",
      },
      400,
    );
  }

  // Patch relationship columns if present.
  // conversations has client_id; orders_cache has client_id.
  if (table === "conversations") {
    (values as any).client_id = clientId;
  } else if (table === "orders_cache") {
    (values as any).client_id = clientId;
  }

  // Upsert other allowlisted tables by id if provided, else error.
  const providedId = body.keys?.id ?? values.id;
  if (typeof providedId !== "string") {
    return jsonResponse({ error: "Missing keys.id for upserting this table" }, 400);
  }

  const upsertValues: Record<string, unknown> = { ...values, id: providedId };

  const { data, error } = await supabase
    .from(table)
    .upsert(upsertValues, { onConflict: "id" })
    .select();

  if (error) return jsonResponse({ error: error.message }, 400);
  return jsonResponse({ ok: true, table, id: providedId, data });
});

import { createClient } from "@/lib/supabase/server";
import { updateClientSettings } from "./actions";
import { CopyField } from "@/components/copy-field";
import type { ClientRow } from "@/lib/types";

const inputCls =
  "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900 disabled:bg-gray-50 disabled:text-gray-500";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      {description ? (
        <p className="mt-0.5 text-xs text-gray-500">{description}</p>
      ) : null}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { saved, error } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user!.id)
    .maybeSingle();
  const canEdit = profile?.role === "admin";

  const { data: clientData } = await supabase
    .from("clients")
    .select(
      "id, name, slug, is_active, store_platform, store_base_url, store_credentials_ref, shipstation_credentials_ref, support_email, phone_number, brand_tone_config, abnormal_status_rules, business_hours, settings",
    )
    .maybeSingle();
  const client = clientData as ClientRow | null;

  if (!client) {
    return (
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Settings</h1>
        <p className="mt-4 text-sm text-gray-400">No client configured.</p>
      </div>
    );
  }

  const tone = client.brand_tone_config ?? {};
  const rules = client.abnormal_status_rules ?? {};
  const abnormalStatuses = Array.isArray(rules.abnormal_statuses)
    ? (rules.abnormal_statuses as string[]).join(", ")
    : "";
  const staleHours =
    typeof rules.stale_after_hours === "number" ? rules.stale_after_hours : 24;

  // Inbound routing. The forwarding address is derived from the client's slug;
  // the domain is the inbox the email-agent Zap watches.
  const inboundDomain =
    process.env.NEXT_PUBLIC_INBOUND_EMAIL_DOMAIN ?? "your-domain.com";
  const forwardingAddress = `proc+${client.slug}@${inboundDomain}`;

  // Support emails the client forwards FROM. Stored as an array in settings;
  // fall back to the legacy single support_email column.
  const settings = (client.settings ?? {}) as { support_emails?: unknown };
  const supportEmails = Array.isArray(settings.support_emails)
    ? (settings.support_emails as string[])
    : client.support_email
      ? [client.support_email]
      : [];

  return (
    <div className="max-w-2xl">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Settings</h1>
        <span className="text-sm text-gray-500">{client.name}</span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Brand/tone, abnormal-status rules, and business hours for this client.
      </p>

      {saved ? (
        <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Settings saved.
        </div>
      ) : null}
      {error ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {!canEdit ? (
        <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
          You have read-only access. Only admins can edit settings.
        </div>
      ) : null}

      <form action={updateClientSettings} className="mt-6 space-y-6">
        <Section title="Workspace">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Client name
            </label>
            <input
              name="name"
              defaultValue={client.name}
              disabled={!canEdit}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Slug
            </label>
            <input value={client.slug} disabled className={inputCls} />
            <p className="mt-1 text-xs text-gray-400">
              Your unique handle. It can&apos;t be changed here because your
              inbound email address is built from it.
            </p>
          </div>
        </Section>

        <Section
          title="Inbound email"
          description="How customer emails reach the agent for this client."
        >
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Your forwarding address
            </label>
            <CopyField value={forwardingAddress} />
            <p className="mt-1 text-xs text-gray-500">
              Forward your support inbox to this address. The agent reads the
              <span className="font-mono"> +{client.slug}</span> tag to route
              mail to your workspace, so keep it intact.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Your support email(s)
            </label>
            <input
              name="support_emails"
              defaultValue={supportEmails.join(", ")}
              placeholder="support@yourstore.com, help@yourstore.com"
              disabled={!canEdit}
              className={inputCls}
            />
            <p className="mt-1 text-xs text-gray-400">
              Comma-separated. The address(es) your customers write to and that
              you forward into the address above. The first is used as your
              primary reply-from.
            </p>
          </div>
        </Section>

        <Section
          title="Store"
          description="The dashboard reads cached orders; the agent fetches them from here."
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Platform
              </label>
              <select
                name="store_platform"
                defaultValue={client.store_platform ?? ""}
                disabled={!canEdit}
                className={inputCls}
              >
                <option value="">— none —</option>
                <option value="woocommerce">WooCommerce</option>
                <option value="shopify">Shopify</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Store URL
              </label>
              <input
                name="store_base_url"
                defaultValue={client.store_base_url ?? ""}
                disabled={!canEdit}
                className={inputCls}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Store credentials ref
              </label>
              <input
                value={client.store_credentials_ref ?? "—"}
                disabled
                className={`${inputCls} font-mono text-xs`}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                ShipStation credentials ref
              </label>
              <input
                value={client.shipstation_credentials_ref ?? "—"}
                disabled
                className={`${inputCls} font-mono text-xs`}
              />
            </div>
          </div>
          <p className="text-xs text-gray-400">
            Credential refs point at a secret vault — secrets are never stored
            here, and they&apos;re managed outside this form.
          </p>
        </Section>

        <Section title="Brand &amp; tone">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Voice
            </label>
            <input
              name="voice"
              defaultValue={(tone.voice as string) ?? ""}
              placeholder="warm, concise, helpful"
              disabled={!canEdit}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Sign-off
            </label>
            <input
              name="sign_off"
              defaultValue={(tone.sign_off as string) ?? ""}
              placeholder="— The Acme Outdoors Team"
              disabled={!canEdit}
              className={inputCls}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              name="use_emoji"
              defaultChecked={Boolean(tone.use_emoji)}
              disabled={!canEdit}
              className="h-4 w-4 rounded border-gray-300"
            />
            Use emoji in replies
          </label>
        </Section>

        <Section
          title="Email instructions"
          description="Extra guidance the email agent follows when drafting replies — policies, phrasing, what to emphasize or avoid. Applies to email only; the phone agent has its own box below."
        >
          <div>
            <textarea
              name="custom_instructions"
              rows={10}
              defaultValue={(tone.custom_instructions as string) ?? ""}
              placeholder={
                "e.g. Always thank the customer for their order. Our standard shipping is 3–5 business days. Never promise refunds or discounts — tell the customer a team member will follow up. Mention our 30-day return policy when relevant."
              }
              disabled={!canEdit}
              className={inputCls}
            />
            <p className="mt-1 text-xs text-gray-400">
              This guidance refines tone and content, but it can&apos;t override
              the agent&apos;s safety rules (it won&apos;t invent order details,
              expose internal flags, or make commitments on flagged orders).
            </p>
          </div>
        </Section>

        <Section
          title="Phone instructions"
          description="Extra guidance the phone agent follows on live calls, on top of the built-in booking flow. Applies to voice only; it doesn't change the email agent."
        >
          <div>
            <textarea
              name="voice_instructions"
              rows={10}
              defaultValue={(tone.voice_instructions as string) ?? ""}
              placeholder={
                "e.g. Greet callers by mentioning our same-day service. If someone asks about financing, tell them we offer 12-month plans and a team member will go over details. Never quote a repair total over the phone — the price is confirmed on site."
              }
              disabled={!canEdit}
              className={inputCls}
            />
            <p className="mt-1 text-xs text-gray-400">
              This refines what the phone agent says, but it can&apos;t override
              its safety rules or booking logic (it won&apos;t invent
              availability, prices, or confirmations).
            </p>
          </div>
        </Section>

        <Section
          title="Escalation rules"
          description="When the agent flags an order for human review."
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Flag orders older than (hours)
              </label>
              <input
                name="stale_after_hours"
                type="number"
                min={0}
                defaultValue={staleHours}
                disabled={!canEdit}
                className={inputCls}
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Abnormal statuses
            </label>
            <input
              name="abnormal_statuses"
              defaultValue={abnormalStatuses}
              placeholder="on-hold, failed, refunded, cancelled"
              disabled={!canEdit}
              className={inputCls}
            />
            <p className="mt-1 text-xs text-gray-400">
              Comma-separated. An order in any of these is flagged.
            </p>
          </div>
        </Section>

        <Section
          title="Business hours"
          description="Free-form JSON for now; the shape is still settling."
        >
          <textarea
            name="business_hours"
            rows={6}
            defaultValue={JSON.stringify(client.business_hours ?? {}, null, 2)}
            disabled={!canEdit}
            className={`${inputCls} font-mono text-xs`}
          />
        </Section>

        {canEdit ? (
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Save settings
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

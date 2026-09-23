import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar, type ProductAccess } from "@/components/sidebar";
import { signout } from "@/app/login/actions";
import { getSeoAccess } from "@/lib/seo-access";
import { featureGate, featureState, getEntitlements, isUsable } from "@/lib/entitlements";
import { addProductHref } from "@/lib/catalog";
import { readProfile } from "@/lib/onboarding";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Defense in depth: the proxy already gates this, but never render the shell
  // without a verified user.
  if (!user) {
    redirect("/login");
  }

  // Tenant + profile for the chrome. RLS scopes this to the caller's client.
  const { data: profile } = await supabase
    .from("users")
    .select("email, full_name, role, clients(name, business_type, products)")
    .eq("id", user.id)
    .single();

  const client = profile?.clients as
    | { name?: string; business_type?: string | null; products?: string[] | null }
    | null;
  const clientName = client?.name ?? "Workspace";
  const { products } = readProfile(client);

  // Same two gates the pages themselves use, so the sidebar can't offer a
  // page that then renders locked (or hide one that would open). Voice is
  // only gated once ENFORCE_ENTITLEMENTS=1; SEO always is (lib/seo-access.ts).
  const [voice, seo] = await Promise.all([featureGate("voice"), getSeoAccess()]);
  // featureGate("voice") is open for everyone while ENFORCE_ENTITLEMENTS is
  // off — that exists so LEGACY voice tenants keep access. A workspace that
  // never set up the phone agent was never one, so without a voice
  // entitlement of its own it gets the collapsed "Add Phone Agent" row
  // instead of five empty phone pages.
  const voiceState = products.includes("voice")
    ? voice.state
    : featureState((await getEntitlements()).voice);
  const voiceUsable = products.includes("voice") ? !voice.locked : isUsable(voiceState);
  const access: ProductAccess = {
    voice: {
      usable: voiceUsable,
      state: voiceState,
      addHref: addProductHref("voice", products),
    },
    seo: {
      usable: seo.allowed,
      state: seo.state,
      addHref: addProductHref("seo", products),
    },
  };
  const displayName = profile?.full_name || profile?.email || user.email || "";

  return (
    <div className="flex min-h-full flex-1">
      <Sidebar clientName={clientName} access={access} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3">
          <div className="text-sm text-gray-500">{displayName}</div>
          <form action={signout}>
            <button
              type="submit"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              Sign out
            </button>
          </form>
        </header>

        <main className="flex-1 overflow-y-auto bg-gray-50 p-6">{children}</main>
      </div>
    </div>
  );
}

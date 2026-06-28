import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";
import { signout } from "@/app/login/actions";

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
    .select("email, full_name, role, clients(name)")
    .eq("id", user.id)
    .single();

  const clientName =
    (profile?.clients as { name?: string } | null)?.name ?? "Workspace";
  const displayName = profile?.full_name || profile?.email || user.email || "";

  return (
    <div className="flex min-h-full flex-1">
      <Sidebar clientName={clientName} />

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

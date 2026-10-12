import { createClient } from "@/lib/supabase/server";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { changeRole, inviteTeammate, reactivateTeammate, removeTeammate, resendInvite } from "./actions";

const inputCls =
  "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";
const smallBtn =
  "rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50";

const ROLE_HELP: Record<string, string> = {
  admin: "Admin: everything, including settings, billing and the team.",
  agent: "Agent: day-to-day use.",
  viewer: "Viewer: read only.",
};

type Member = {
  user_id: string | null;
  email: string;
  full_name: string | null;
  role: "admin" | "agent" | "viewer";
  status: "active" | "invited" | "deactivated";
  invited_at: string | null;
  last_sign_in_at: string | null;
  is_me: boolean;
};

const STATUS_ORDER = { active: 0, invited: 1, deactivated: 2 } as const;

function StatusBadge({ status }: { status: Member["status"] }) {
  const cls =
    status === "active"
      ? "bg-green-50 text-green-700"
      : status === "invited"
        ? "bg-amber-50 text-amber-700"
        : "bg-gray-100 text-gray-500";
  const label = status === "active" ? "Active" : status === "invited" ? "Invited" : "Deactivated";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ invited?: string; saved?: string; removed?: string; error?: string }>;
}) {
  const { invited, saved, removed, error } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user!.id)
    .maybeSingle();
  const isAdmin = profile?.role === "admin";

  const { data, error: loadError } = await supabase.rpc("team_members");
  const members = ((data ?? []) as Member[]).sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      a.email.localeCompare(b.email),
  );

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold text-gray-900">Team</h1>
      <p className="mt-1 text-sm text-gray-500">
        Everyone who can sign in to this workspace.
      </p>

      {invited ? (
        <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
          Invite sent to {invited}. They&rsquo;ll get an email with a link to set
          their password.
        </div>
      ) : null}
      {saved ? (
        <div className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">Saved.</div>
      ) : null}
      {removed ? (
        <div className="mt-4 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
          Removed. Their login is deleted; anything they approved or wrote
          stays. You can invite the same email again later.
        </div>
      ) : null}
      {error || loadError ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error ?? loadError?.message}
        </div>
      ) : null}

      {isAdmin ? (
        <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">Invite someone</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            They&rsquo;ll get an email from LumiLink with a link to join this
            workspace and set a password.
          </p>
          <form action={inviteTeammate} className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700">Email</label>
                <input name="email" type="email" required className={inputCls} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Name <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <input name="full_name" className={inputCls} />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Role</label>
              <select name="role" defaultValue="agent" className={inputCls}>
                <option value="agent">Agent</option>
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
              <p className="mt-1 text-xs text-gray-400">
                {ROLE_HELP.admin} {ROLE_HELP.agent} {ROLE_HELP.viewer}
              </p>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
              >
                Send invite
              </button>
            </div>
          </form>
        </section>
      ) : (
        <div className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Only admins can invite or remove people.
        </div>
      )}

      <section className="mt-6 rounded-lg border border-gray-200 bg-white">
        <ul className="divide-y divide-gray-100">
          {members.map((m) => (
            <li key={m.user_id ?? `invite:${m.email}`} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">
                  {m.full_name || m.email}
                  {m.is_me ? <span className="ml-1 font-normal text-gray-400">(you)</span> : null}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {m.full_name ? `${m.email} · ` : ""}
                  {m.status === "invited" && m.invited_at
                    ? `Invited ${new Date(m.invited_at).toLocaleDateString()}`
                    : m.last_sign_in_at
                      ? `Last signed in ${new Date(m.last_sign_in_at).toLocaleDateString()}`
                      : null}
                </p>
              </div>
              <StatusBadge status={m.status} />

              {isAdmin && !m.is_me ? (
                <div className="flex items-center gap-2">
                  {m.user_id && m.status !== "deactivated" ? (
                    <form action={changeRole} className="flex items-center gap-1">
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <select
                        name="role"
                        defaultValue={m.role}
                        aria-label={`Role for ${m.email}`}
                        className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-900"
                      >
                        <option value="admin">Admin</option>
                        <option value="agent">Agent</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button className={smallBtn}>Save</button>
                    </form>
                  ) : (
                    <span className="text-xs capitalize text-gray-500">{m.role}</span>
                  )}

                  {m.status === "invited" ? (
                    <form action={resendInvite}>
                      <input type="hidden" name="email" value={m.email} />
                      <button className={smallBtn}>Resend</button>
                    </form>
                  ) : null}

                  {/* Only people removed before 0086 are "deactivated". */}
                  {m.status === "deactivated" && m.user_id ? (
                    <form action={reactivateTeammate}>
                      <input type="hidden" name="user_id" value={m.user_id} />
                      <button className={smallBtn}>Reactivate</button>
                    </form>
                  ) : null}
                  <form action={removeTeammate}>
                    <input type="hidden" name="user_id" value={m.user_id ?? ""} />
                    <input type="hidden" name="email" value={m.email} />
                    <ConfirmSubmit
                      className={`${smallBtn} text-red-700`}
                      message={
                        m.status === "invited"
                          ? `Cancel the invite for ${m.email}?`
                          : `Remove ${m.full_name || m.email} permanently? Their login is deleted. Anything they approved or wrote stays.`
                      }
                    >
                      {m.status === "invited" ? "Cancel invite" : m.status === "deactivated" ? "Remove permanently" : "Remove"}
                    </ConfirmSubmit>
                  </form>
                </div>
              ) : (
                <span className="text-xs capitalize text-gray-500">{m.role}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

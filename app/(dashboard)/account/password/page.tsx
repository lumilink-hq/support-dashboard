import { createClient } from "@/lib/supabase/server";
import { setPassword } from "./actions";

const inputCls =
  "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";

export default async function PasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("name").maybeSingle();

  return (
    <div className="max-w-sm">
      <h1 className="text-lg font-semibold text-gray-900">Set your password</h1>
      <p className="mt-1 text-sm text-gray-500">
        {client?.name ? `You're signed in to ${client.name}. ` : ""}
        Choose a password to use next time you sign in.
      </p>

      {error ? (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      ) : null}

      <form action={setPassword} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">New password</label>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            className={inputCls}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Confirm password</label>
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            className={inputCls}
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Save password
        </button>
      </form>
    </div>
  );
}

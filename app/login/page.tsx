import Link from "next/link";
import { login } from "./actions";
import { safeNextPath } from "@/lib/route-access";

export default async function LoginPage({
  searchParams,
}: {
  // Next 16: searchParams is async.
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;

  // Sanitised here as well as in the action. The action is the security
  // boundary; doing it here too means the hidden field never carries a hostile
  // value to be echoed back into the page.
  const nextPath = safeNextPath(next);
  const returningToCheckout = nextPath === "/plans";

  return (
    <main className="flex min-h-full items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Support Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          {returningToCheckout
            ? "Sign in to continue to checkout."
            : "Sign in to your workspace."}
        </p>

        {error ? (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <form action={login} className="mt-6 space-y-4">
          <input type="hidden" name="next" value={nextPath} />
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-gray-700"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-sm text-gray-500">
          New here?{" "}
          <Link
            href={
              returningToCheckout
                ? `/signup?next=${encodeURIComponent(nextPath)}`
                : "/signup"
            }
            className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            Create a workspace
          </Link>
        </p>

        {returningToCheckout ? (
          <p className="mt-4 text-xs text-gray-400">
            Your plan is waiting. We&rsquo;ll take you back to checkout once
            you&rsquo;re in.
          </p>
        ) : null}
      </div>
    </main>
  );
}

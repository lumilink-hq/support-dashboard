import Link from "next/link";
import { requestPasswordReset } from "./actions";

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const { sent, error } = await searchParams;

  return (
    <main className="flex min-h-full items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Reset your password</h1>

        {sent ? (
          <>
            <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">
              If that email has a LumiLink account, a link to choose a new
              password is on its way. It can take a minute or two.
            </p>
            <p className="mt-4 text-sm text-gray-500">
              Nothing arrived? Check spam, or{" "}
              <Link href="/forgot-password" className="font-medium text-gray-900 underline underline-offset-4">
                try again
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-gray-500">
              Enter the email you sign in with and we&rsquo;ll send you a link
              to choose a new password.
            </p>

            {error ? (
              <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            ) : null}

            <form action={requestPasswordReset} className="mt-6 space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700">
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
              <button
                type="submit"
                className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
              >
                Send reset link
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-sm text-gray-500">
          <Link href="/login" className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

import Link from "next/link";
import { signup } from "./actions";
import { safeNextPath } from "@/lib/route-access";

export default async function SignupPage({
  searchParams,
}: {
  // Next 16: searchParams is async.
  searchParams: Promise<{ error?: string; confirm?: string; next?: string }>;
}) {
  const { error, confirm, next } = await searchParams;
  // Sanitised here and again in the action; the action is the security boundary.
  const nextPath = safeNextPath(next);

  // Post-submit: account created, waiting on email confirmation.
  if (confirm) {
    return (
      <main className="flex min-h-full items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-gray-900">Check your email</h1>
          <p className="mt-2 text-sm text-gray-600">
            We sent you a confirmation link. Click it to activate your workspace,
            then sign in.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block text-sm font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Create your workspace</h1>
        <p className="mt-1 text-sm text-gray-500">
          Set up a new support dashboard for your business.
        </p>

        {error ? (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <form action={signup} className="mt-6 space-y-4">
          <input type="hidden" name="next" value={nextPath} />
          <div>
            <label
              htmlFor="business_name"
              className="block text-sm font-medium text-gray-700"
            >
              Business name
            </label>
            <input
              id="business_name"
              name="business_name"
              type="text"
              autoComplete="organization"
              required
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
          </div>

          {/*
            THE ARCHETYPE. Asked at signup rather than in the wizard, because it
            decides which wizard the client sees — an HVAC company must never be
            shown the store-connection step, and a shop must never be asked for
            call-out fees.

            Radios, not a select: two options, and the difference between them
            is worth a sentence each. A dropdown hides that explanation behind a
            click and gets picked wrong.
          */}
          <fieldset>
            <legend className="block text-sm font-medium text-gray-700">
              What does your business do?
            </legend>
            <div className="mt-2 space-y-2">
              <label className="flex cursor-pointer gap-3 rounded-md border border-gray-300 p-3 hover:bg-gray-50 has-[:checked]:border-gray-900 has-[:checked]:bg-gray-50">
                <input
                  type="radio"
                  name="business_type"
                  value="service"
                  defaultChecked
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900">
                    We book appointments
                  </span>
                  <span className="block text-xs text-gray-500">
                    HVAC, plumbing, electrical, salons, clinics. Callers want to
                    book a job or get a price.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer gap-3 rounded-md border border-gray-300 p-3 hover:bg-gray-50 has-[:checked]:border-gray-900 has-[:checked]:bg-gray-50">
                <input
                  type="radio"
                  name="business_type"
                  value="ecommerce"
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm font-medium text-gray-900">
                    We sell online
                  </span>
                  <span className="block text-xs text-gray-500">
                    A store with orders to look up. Callers ask where their
                    order is, or about a product.
                  </span>
                </span>
              </label>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              You can change this later.
            </p>
          </fieldset>

          <div>
            <label
              htmlFor="full_name"
              className="block text-sm font-medium text-gray-700"
            >
              Your name
            </label>
            <input
              id="full_name"
              name="full_name"
              type="text"
              autoComplete="name"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-gray-700"
            >
              Work email
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
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
            <p className="mt-1 text-xs text-gray-400">At least 8 characters.</p>
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Create workspace
          </button>
        </form>

        <p className="mt-6 text-sm text-gray-500">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}

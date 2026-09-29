import Link from "next/link";
import { signup } from "./actions";
import { safeNextPath } from "@/lib/route-access";
import { productByKey, type ProductKey } from "@/lib/catalog";
import { INDUSTRY_OPTIONS } from "@/lib/onboarding";

const labelClass = "block text-sm font-medium text-gray-700";
const inputClass =
  "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";

export default async function SignupPage({
  searchParams,
}: {
  // Next 16: searchParams is async.
  searchParams: Promise<{
    error?: string;
    confirm?: string;
    next?: string;
    product?: string;
    type?: string;
  }>;
}) {
  const { error, confirm, next, product: productParam, type } = await searchParams;
  // Sanitised here and again in the action; the action is the security boundary.
  const nextPath = safeNextPath(next);
  // THE PRODUCT COMES FROM THE LINK, NOT A QUESTION. A product page links
  // here with ?product=… (/products/seo sends ?product=seo); anything else
  // signs up for the phone agent, which is what every other CTA sells.
  // ?type=seo is the pre-2026-09-23 spelling of the same link. actions.ts
  // and handle_new_user (0059) both validate it again.
  const product: ProductKey =
    productParam === "seo" || type === "seo" ? "seo" : "voice";
  // ?type=ecommerce still preselects the online-store option. Otherwise
  // nothing is preselected: with seven options a default is a guess, and a
  // wrong one silently picks the wrong wizard.
  const defaultOption = type === "ecommerce" ? "ecommerce" : null;

  // Post-submit: account created, waiting on email confirmation.
  if (confirm) {
    return (
      <main className="flex min-h-full items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-gray-900">Check Your Email</h1>
          <p className="mt-2 text-sm text-gray-600">
            We sent you a confirmation link. Click it to activate your workspace,
            then sign in.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block text-sm font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            Back To Sign In
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-gray-900">Create Your Workspace</h1>
        <p className="mt-1 text-sm text-gray-500">
          {product === "seo"
            ? `Start with ${productByKey("seo").name}.`
            : "Set up a workspace for your business."}{" "}
          You can add other products later.
        </p>

        {error ? (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <form action={signup} className="mt-6 space-y-4">
          <input type="hidden" name="next" value={nextPath} />
          <input type="hidden" name="product" value={product} />
          {/*
            FULL NAME FIRST, AND REQUIRED (2026-09-28). It was an optional
            "Your name" below the industry question, so plenty of workspaces
            had an owner with no name on file.
          */}
          <div>
            <label htmlFor="full_name" className={labelClass}>
              Full Name
            </label>
            <input
              id="full_name"
              name="full_name"
              type="text"
              autoComplete="name"
              autoCapitalize="words"
              required
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="business_name" className={labelClass}>
              Business Name
            </label>
            <input
              id="business_name"
              name="business_name"
              type="text"
              autoComplete="organization"
              autoCapitalize="words"
              required
              className={inputClass}
            />
          </div>

          {/*
            THE INDUSTRY. Asked at signup rather than in the wizard, because it
            decides which wizard the client sees — an HVAC company must never be
            shown the store-connection step, and a shop must never be asked for
            call-out fees. Asked for every product, including SEO: it's what
            the client IS, so it's still right if they add the phone agent
            later.

            SEVEN OPTIONS, NOT TWO (2026-09-28). "We book appointments" / "We
            sell online" left most businesses guessing. Each option maps onto
            the stored two-value industry (INDUSTRY_OPTIONS, lib/onboarding.ts).
            Still radios, not a select: each option's one-line description is
            what stops it being picked wrong.
          */}
          <fieldset>
            <legend className={labelClass}>What Kind Of Business Are You?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {INDUSTRY_OPTIONS.map((o) => (
                <label
                  key={o.key}
                  className="flex cursor-pointer gap-2.5 rounded-md border border-gray-300 p-2.5 hover:bg-gray-50 has-[:checked]:border-gray-900 has-[:checked]:bg-gray-50"
                >
                  <input
                    type="radio"
                    name="business_type"
                    value={o.key}
                    required
                    defaultChecked={o.key === defaultOption}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">{o.title}</span>
                    <span className="block text-xs leading-snug text-gray-500">{o.body}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-400">You can change this later.</p>
          </fieldset>

          <div>
            <label htmlFor="email" className={labelClass}>
              Work Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="password" className={labelClass}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-400">At least 8 characters.</p>
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          >
            Create Workspace
          </button>
        </form>

        <p className="mt-6 text-sm text-gray-500">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-gray-900 underline underline-offset-4 hover:text-gray-700"
          >
            Sign In
          </Link>
        </p>
      </div>
    </main>
  );
}

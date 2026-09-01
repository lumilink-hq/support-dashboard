// "/contact" — public contact form for two audiences (new here / already a
// customer), per the 2026-08-30 repositioning brief. Submits to
// contact_submissions (migration 0038) via ./actions.ts.

import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/shell";
import { Eyebrow, Section } from "@/components/marketing/blocks";
import { safeNextPath } from "@/lib/route-access";
import { submitContact } from "./actions";

export const metadata: Metadata = {
  title: "Contact LumiLink",
  description:
    "New here and want more than the self-serve plans cover, or already a customer with a question? Tell us what's going on.",
  alternates: { canonical: "/contact" },
};

export default async function ContactPage({
  searchParams,
}: {
  // Next 16: searchParams is async. `source`/`topic` arrive from a partner
  // page's CTA via partnerContactHref() — they pre-fill the form instead of
  // leaving someone to write everything from scratch.
  searchParams: Promise<{
    sent?: string;
    error?: string;
    source?: string;
    topic?: string;
  }>;
}) {
  const { sent, error, source, topic } = await searchParams;
  const sourcePath = safeNextPath(source, "/contact");
  const messagePrefill = topic ? `Interested in: ${topic}\n\n` : "";

  return (
    <MarketingShell>
      <Section className="py-20">
        <div className="mx-auto max-w-xl">
          <Eyebrow>Contact</Eyebrow>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-gray-900">
            Talk To Us
          </h1>
          <p className="mt-3 text-gray-600">
            New here and want more than the self-serve plans cover, or already
            a customer with a question? Either way, tell us what&rsquo;s going
            on. We&rsquo;re constantly developing, so what you ask for today
            can become what we build next.
          </p>

          {sent ? (
            <p className="mt-8 rounded-md bg-green-50 px-4 py-3 text-sm text-green-800">
              Sent. We read every one of these ourselves, and we&rsquo;ll get
              back to you.
            </p>
          ) : (
            <form action={submitContact} className="mt-8 space-y-5">
              <input type="hidden" name="source_path" value={sourcePath} />

              {/*
                Honeypot. Hidden from sighted users via `hidden`, from screen
                readers via aria-hidden, and pulled out of tab order — a bot
                that fills every field in the DOM fills this one too, a human
                never sees it exists.
              */}
              <div className="hidden" aria-hidden="true">
                <label htmlFor="company_website">Leave this field empty</label>
                <input
                  id="company_website"
                  name="company_website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>

              {error ? (
                <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </p>
              ) : null}

              <fieldset>
                <legend className="block text-sm font-medium text-gray-700">
                  Which one is you?
                </legend>
                <div className="mt-2 space-y-2">
                  <label className="flex cursor-pointer gap-3 rounded-md border border-gray-300 p-3 hover:bg-gray-50 has-[:checked]:border-gray-900 has-[:checked]:bg-gray-50">
                    <input
                      type="radio"
                      name="audience"
                      value="new"
                      defaultChecked
                      className="mt-0.5"
                    />
                    <span className="text-sm font-medium text-gray-900">
                      New here
                    </span>
                  </label>
                  <label className="flex cursor-pointer gap-3 rounded-md border border-gray-300 p-3 hover:bg-gray-50 has-[:checked]:border-gray-900 has-[:checked]:bg-gray-50">
                    <input
                      type="radio"
                      name="audience"
                      value="existing"
                      className="mt-0.5"
                    />
                    <span className="text-sm font-medium text-gray-900">
                      Already a customer
                    </span>
                  </label>
                </div>
              </fieldset>

              <div>
                <label
                  htmlFor="name"
                  className="block text-sm font-medium text-gray-700"
                >
                  Name
                </label>
                <input
                  id="name"
                  name="name"
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
                  htmlFor="message"
                  className="block text-sm font-medium text-gray-700"
                >
                  What&rsquo;s going on?
                </label>
                <textarea
                  id="message"
                  name="message"
                  rows={5}
                  required
                  defaultValue={messagePrefill}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
              >
                Send
              </button>
            </form>
          )}
        </div>
      </Section>
    </MarketingShell>
  );
}

// =============================================================================
// /onboarding — the post-payment wizard.
//
// Asks for the things the agent needs to sound competent, at the one moment the
// client is motivated: right after they have paid. Before this existed, prices
// and hours lived on dashboard pages a client had no reason to visit until
// after their number went live, so the first call an agent took was often its
// worst.
//
// BRANCHES ON business_type (0032/0034). A service client is never shown the
// store step; a shop is never asked for call-out fees.
//
// Resumable: lands on the first incomplete step, because people abandon a form
// that asks for a price list and come back later.
// =============================================================================

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentClientId } from "@/lib/entitlements";
import {
  type BusinessType,
  type StepKey,
  COMMON_TIMEZONES,
  WEEKDAYS,
  blockingRemaining,
  firstIncompleteStep,
  isStepDone,
  progress,
  readOnboarding,
  stepsFor,
} from "@/lib/onboarding";
import {
  acknowledgeNumber,
  addService,
  deferStore,
  finishServices,
  removeService,
  saveBasics,
  saveBehaviour,
  saveWebsite,
  submitIntakeRequest,
} from "./actions";

export const metadata: Metadata = { title: "Set up Lumi | Lumilink" };

const input =
  "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900";
const label = "block text-sm font-medium text-gray-700";
const primary =
  "rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800";
const secondary =
  "rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; error?: string; sent?: string }>;
}) {
  const { step: stepParam, error, sent } = await searchParams;

  const clientId = await getCurrentClientId();
  if (!clientId) redirect("/login?next=%2Fonboarding");

  const supabase = await createClient();
  const [{ data: client }, { data: services }, { data: kbDocs }] = await Promise.all([
    supabase
      .from("clients")
      .select("name, business_type, phone_number, settings")
      .eq("id", clientId)
      .maybeSingle(),
    supabase
      .from("services")
      .select("id, name, price_type, price, callout_fee, default_duration_min, emergency_eligible")
      .eq("client_id", clientId)
      .order("created_at"),
    supabase
      .from("kb_documents")
      .select("id, title, source_uri, status, chunk_count, last_error")
      .eq("client_id", clientId)
      .order("created_at"),
  ]);

  const settings = (client?.settings ?? {}) as Record<string, unknown>;
  const businessType = (client?.business_type ?? null) as BusinessType | null;
  const state = readOnboarding(settings);
  const steps = stepsFor(businessType);
  const { done, total, percent } = progress(state, businessType);
  const blocking = blockingRemaining(state, businessType);

  // Requested step, else resume, else the last step so a returning client sees
  // a finished wizard rather than being bounced somewhere arbitrary.
  const requested = steps.find((s) => s.key === stepParam)?.key;
  const active: StepKey =
    requested ?? firstIncompleteStep(state, businessType) ?? steps[steps.length - 1].key;

  const scheduling = (settings.scheduling ?? {}) as Record<string, unknown>;
  const hours = (scheduling.hours ?? {}) as Record<string, string[]>;

  return (
    <main className="min-h-full bg-gray-50 py-10">
      <div className="mx-auto max-w-3xl px-6">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-900">
              Let&rsquo;s get your phone answering
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              {client?.name ? `Setting up ${client.name}. ` : ""}
              You can stop and come back to it whenever suits you.
            </p>
          </div>
          <Link href="/conversations" className="shrink-0 text-sm text-gray-500 underline">
            Skip for now
          </Link>
        </div>

        {/* Progress */}
        <div className="mt-6">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>
              {done} of {total} done
            </span>
            <span>{percent}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
            <div className="h-full bg-gray-900" style={{ width: `${percent}%` }} />
          </div>
        </div>

        {/*
          WHY YOU ARE NOT LIVE YET. Shown whenever a blocking step is
          outstanding. The alternative is a client sitting on "Setting up your
          plan…" with no cause named, which generates a support message every
          single time.
        */}
        {blocking.length > 0 ? (
          <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <h2 className="text-sm font-semibold text-amber-900">
              Your plan is paid. {blocking.length === 1 ? "One thing" : `${blocking.length} things`}{" "}
              left before Lumi can answer:
            </h2>
            <ul className="mt-2 space-y-1 text-sm text-amber-800">
              {blocking.map((s) => (
                <li key={s.key}>
                  <Link href={`/onboarding?step=${s.key}`} className="underline">
                    {s.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="mt-6 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            Everything we need is in. We&rsquo;re finishing your setup now, and
            your number appears in Settings as soon as Lumi is live.
          </div>
        )}

        {/* Step nav */}
        <nav className="mt-6 flex flex-wrap gap-2">
          {steps.map((s, i) => {
            const complete = isStepDone(state, s.key);
            const current = s.key === active;
            return (
              <Link
                key={s.key}
                href={`/onboarding?step=${s.key}`}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  current
                    ? "border-gray-900 bg-gray-900 text-white"
                    : complete
                      ? "border-green-300 bg-green-50 text-green-800"
                      : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {complete && !current ? "✓ " : `${i + 1}. `}
                {s.title}
              </Link>
            );
          })}
        </nav>

        <section className="mt-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          {steps
            .filter((s) => s.key === active)
            .map((s) => (
              <div key={s.key}>
                <h2 className="text-lg font-semibold text-gray-900">{s.title}</h2>
                <p className="mt-1 text-sm text-gray-500">{s.blurb}</p>
              </div>
            ))}

          {/* ---------------------------------------------------------------- */}
          {active === "basics" ? (
            <form action={saveBasics} className="mt-6 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={label} htmlFor="timezone">
                    Timezone
                  </label>
                  <select
                    id="timezone"
                    name="timezone"
                    defaultValue={(scheduling.timezone as string) ?? "America/Los_Angeles"}
                    className={input}
                  >
                    {COMMON_TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz.replace("America/", "").replace("Pacific/", "").replace("_", " ")}
                      </option>
                    ))}
                  </select>
                  {/*
                    The single most expensive field in the wizard. A wrong
                    timezone books real customers into hours the business is
                    shut, and they find out by turning up.
                  */}
                  <p className="mt-1 text-xs text-gray-400">
                    Bookings are offered in this timezone. Worth double-checking.
                  </p>
                </div>
                <div>
                  <label className={label} htmlFor="area_code">
                    Preferred area code
                  </label>
                  <input
                    id="area_code"
                    name="area_code"
                    inputMode="numeric"
                    maxLength={3}
                    placeholder="213"
                    defaultValue={(scheduling.area_code as string) ?? ""}
                    className={input}
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    We&rsquo;ll try to get you a local number.
                  </p>
                </div>
              </div>

              <div>
                <label className={label} htmlFor="service_area">
                  Where do you work?
                </label>
                <input
                  id="service_area"
                  name="service_area"
                  placeholder="Los Angeles County and Orange County"
                  defaultValue={(scheduling.service_area as string) ?? ""}
                  className={input}
                />
                <p className="mt-1 text-xs text-gray-400">
                  In the words you&rsquo;d use with a customer. Lumi says this back to callers.
                </p>
              </div>

              <fieldset>
                <legend className={label}>Opening hours</legend>
                <div className="mt-2 space-y-2">
                  {WEEKDAYS.map((day) => {
                    const existing = hours[day.key]?.[0] ?? "";
                    const [open, close] = existing.split("-");
                    const closed = !existing;
                    return (
                      <div key={day.key} className="flex items-center gap-3">
                        <span className="w-24 text-sm text-gray-700">{day.label}</span>
                        <input
                          type="time"
                          name={`${day.key}_open`}
                          defaultValue={open || "08:00"}
                          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                        />
                        <span className="text-sm text-gray-400">to</span>
                        <input
                          type="time"
                          name={`${day.key}_close`}
                          defaultValue={close || "17:00"}
                          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                        />
                        <label className="flex items-center gap-1.5 text-sm text-gray-500">
                          <input
                            type="checkbox"
                            name={`${day.key}_closed`}
                            defaultChecked={closed && (day.key === "sat" || day.key === "sun")}
                          />
                          Closed
                        </label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              <button type="submit" className={primary}>
                Save and continue
              </button>
            </form>
          ) : null}

          {/* ---------------------------------------------------------------- */}
          {active === "website" ? (
            <div className="mt-6 space-y-5">
              <form action={saveWebsite} className="space-y-4">
                <div>
                  <label className={label} htmlFor="website_url">
                    Your website address
                  </label>
                  <input
                    id="website_url"
                    name="website_url"
                    placeholder="acme-heating.com"
                    defaultValue={(settings.website_url as string) ?? ""}
                    className={input}
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    We read your public pages so Lumi can answer general questions.
                    We don&rsquo;t change anything on your site.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="submit" className={primary}>
                    Save and continue
                  </button>
                  <button
                    type="submit"
                    name="website_url"
                    value=""
                    className={secondary}
                  >
                    I don&rsquo;t have one
                  </button>
                </div>
              </form>

              {kbDocs && kbDocs.length > 0 ? (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <h3 className="text-sm font-medium text-gray-900">What Lumi has read</h3>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {kbDocs.map((d) => (
                      <li key={d.id} className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-gray-700">{d.title}</span>
                        <span
                          className={`shrink-0 text-xs ${
                            d.status === "ready"
                              ? "text-green-700"
                              : d.status === "failed"
                                ? "text-red-600"
                                : "text-gray-400"
                          }`}
                        >
                          {d.status === "ready"
                            ? `${d.chunk_count} sections`
                            : d.status === "failed"
                              ? "couldn't read"
                              : "reading…"}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {/*
                    A failed document is worth surfacing to the client, because
                    the usual cause is a JavaScript-rendered site and the fix is
                    something only they can do.
                  */}
                  {kbDocs.some((d) => d.status === "failed") ? (
                    <p className="mt-2 text-xs text-gray-500">
                      Some pages couldn&rsquo;t be read automatically. We&rsquo;ll
                      follow up and add them by hand.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* ---------------------------------------------------------------- */}
          {active === "services" ? (
            <div className="mt-6 space-y-6">
              {error === "empty" ? (
                <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  Add at least one service. Without a price list Lumi can&rsquo;t
                  answer &ldquo;how much&rdquo;, which is what most people call to ask.
                </p>
              ) : null}

              {services && services.length > 0 ? (
                <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {services.map((sv) => (
                    <li key={sv.id} className="flex items-center justify-between gap-3 p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">{sv.name}</p>
                        <p className="text-xs text-gray-500">
                          {sv.price_type === "fixed"
                            ? `$${sv.price} fixed`
                            : `Quote after a $${sv.callout_fee ?? 0} call-out`}
                          {" · "}
                          {sv.default_duration_min} min
                          {sv.emergency_eligible ? " · emergency" : ""}
                        </p>
                      </div>
                      <form action={removeService}>
                        <input type="hidden" name="service_id" value={sv.id} />
                        <button className="text-xs text-gray-400 underline hover:text-red-600">
                          Remove
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              ) : null}

              <form action={addService} className="space-y-4 rounded-lg border border-gray-200 p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className={label} htmlFor="name">
                      Service name
                    </label>
                    <input id="name" name="name" required placeholder="AC repair" className={input} />
                  </div>

                  <div>
                    <label className={label} htmlFor="price_type">
                      How is it priced?
                    </label>
                    <select id="price_type" name="price_type" className={input}>
                      <option value="quote">Quote after a call-out</option>
                      <option value="fixed">Fixed price</option>
                    </select>
                    {/*
                      Quote-only is the default because most trades do not want
                      a total said on the phone — callers treat a number as a
                      promise, and the technician has not seen the job.
                    */}
                    <p className="mt-1 text-xs text-gray-400">
                      Most repairs are quote-only. Lumi quotes the call-out fee
                      and won&rsquo;t guess a total.
                    </p>
                  </div>

                  <div>
                    <label className={label} htmlFor="price">
                      Fixed price
                    </label>
                    <input id="price" name="price" inputMode="decimal" placeholder="129" className={input} />
                    <label className={`${label} mt-3`} htmlFor="callout_fee">
                      Call-out fee
                    </label>
                    <input id="callout_fee" name="callout_fee" inputMode="decimal" placeholder="89" className={input} />
                  </div>

                  <div>
                    <label className={label} htmlFor="duration">
                      Typical length (minutes)
                    </label>
                    <input id="duration" name="duration" type="number" min={15} step={15} defaultValue={60} className={input} />
                  </div>

                  <div className="flex items-end">
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" name="emergency" />
                      Available as an emergency call-out
                    </label>
                  </div>
                </div>

                <button type="submit" className={secondary}>
                  Add service
                </button>
              </form>

              <form action={finishServices}>
                <button type="submit" className={primary}>
                  Save and continue
                </button>
              </form>
            </div>
          ) : null}

          {/* ---------------------------------------------------------------- */}
          {active === "store" ? (
            <form action={deferStore} className="mt-6 space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={label} htmlFor="store_platform">
                    What do you sell on?
                  </label>
                  <select id="store_platform" name="store_platform" className={input}>
                    <option value="">Choose…</option>
                    <option value="shopify">Shopify</option>
                    <option value="woocommerce">WooCommerce</option>
                    <option value="other">Something else</option>
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="store_base_url">
                    Store address
                  </label>
                  <input id="store_base_url" name="store_base_url" placeholder="shop.acme.com" className={input} />
                </div>
              </div>

              {/*
                DELIBERATELY DOES NOT COLLECT API KEYS.

                clients.store_credentials_ref holds a vault:// POINTER, and
                Supabase Vault is not implemented yet. A form that accepted a key
                here would have to put it somewhere, and the only somewhere
                available is a column the client's own dashboard can read.

                Setting store_platform on the client row is also withheld:
                provisionVoice refuses to provision a client with store_platform
                set and no credentials ref, so writing it now would park them at
                needs_human for a feature they cannot use yet.
              */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                <p className="font-medium text-gray-900">We&rsquo;ll take it from here</p>
                <p className="mt-1">
                  Connecting your store needs API keys, which we set up with you
                  directly rather than over a form. Tell us the platform above
                  and we&rsquo;ll be in touch to finish it.
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Lumi still answers calls, hours and general questions while
                  this is pending. Only order lookups wait on it.
                </p>
              </div>

              <button type="submit" className={primary}>
                Save and continue
              </button>
            </form>
          ) : null}

          {/* ---------------------------------------------------------------- */}
          {active === "number" ? (
            <form action={acknowledgeNumber} className="mt-6 space-y-5">
              {client?.phone_number ? (
                <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                  <p className="text-sm text-green-900">
                    Your number is{" "}
                    <span className="font-semibold">{client.phone_number}</span>
                  </p>
                  <p className="mt-1 text-sm text-green-800">
                    Call it once yourself before you give it to customers. You
                    should hear Lumi answer in your business&rsquo;s name.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-sm font-medium text-gray-900">
                    We&rsquo;re assigning your number
                  </p>
                  {/*
                    TWO PROMISES REMOVED (2026-08-13).

                    "We'll email you the moment it's ready" — there is no
                    email-sending code in this repo, and auth mail is still
                    waiting on SMTP. Promising a notification we cannot send is
                    the kind of small lie a customer remembers.

                    "Already have a number? We'll use that instead" — porting
                    is not supported, and the site's FAQ now says so plainly.
                    Two parts of the product answering the same question
                    differently is worse than either answer.
                  */}
                  <p className="mt-1 text-sm text-gray-600">
                    We pick a number in your area code and set it up on our
                    system &mdash; nothing needed from you. It appears in
                    Settings as soon as it&rsquo;s live.
                  </p>
                  <p className="mt-2 text-xs text-gray-500">
                    We can&rsquo;t move an existing number across yet, so your
                    agent answers on the new one. Forwarding your old line to it
                    works if you&rsquo;d rather keep the number you advertise.
                  </p>
                </div>
              )}
              <button type="submit" className={primary}>
                Got it, continue
              </button>
            </form>
          ) : null}

          {/* ---------------------------------------------------------------- */}
          {active === "behaviour" ? (
            <div className="mt-6 space-y-6">
              {sent ? (
                <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
                  Sent. We read every one of these and will get it into Lumi.
                </p>
              ) : null}

              <form action={saveBehaviour} className="space-y-5">
                <div>
                  <label className={label} htmlFor="greeting">
                    How should Lumi answer the phone?
                  </label>
                  <input
                    id="greeting"
                    name="greeting"
                    placeholder={`Thanks for calling ${client?.name ?? "your business"}, this is Lumi.`}
                    defaultValue={(settings.voice_greeting as string) ?? ""}
                    className={input}
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    Leave blank and we&rsquo;ll use your business name.
                  </p>
                </div>

                <fieldset>
                  <legend className={label}>
                    When Lumi can&rsquo;t help, what should it do?
                  </legend>
                  <div className="mt-2 space-y-2">
                    <label className="flex items-start gap-2 text-sm text-gray-700">
                      <input
                        type="radio"
                        name="escalation_mode"
                        value="callback"
                        defaultChecked={settings.escalation_mode !== "email"}
                        className="mt-1"
                      />
                      <span>
                        Take a number and raise a callback
                        <span className="block text-xs text-gray-400">
                          Nothing gets lost. You&rsquo;ll see it in your dashboard.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-gray-700">
                      <input
                        type="radio"
                        name="escalation_mode"
                        value="email"
                        defaultChecked={settings.escalation_mode === "email"}
                        className="mt-1"
                      />
                      <span>
                        Give out our support email
                        <span className="block text-xs text-gray-400">
                          Only pick this if someone actually watches that inbox.
                        </span>
                      </span>
                    </label>
                  </div>
                </fieldset>

                <div>
                  <label className={label} htmlFor="never_say">
                    Anything Lumi should never say or promise?
                  </label>
                  <textarea
                    id="never_say"
                    name="never_say"
                    rows={3}
                    placeholder="Never quote a repair total on the phone. Never promise same-day service."
                    className={input}
                  />
                </div>

                <div>
                  <label className={label} htmlFor="notes">
                    Anything else you want Lumi to know or do?
                  </label>
                  <textarea
                    id="notes"
                    name="notes"
                    rows={4}
                    placeholder="We charge double time on Sundays. If someone asks about financing, tell them we offer 12 months at 0%."
                    className={input}
                  />
                  {/*
                    Sets the expectation honestly. This text does NOT reach the
                    agent on save — it becomes a request an operator reads. Copy
                    that implied otherwise would be a promise the system
                    deliberately does not keep.
                  */}
                  <p className="mt-1 text-xs text-gray-400">
                    A real person reads these and gets them into Lumi, usually
                    within a day. That&rsquo;s on purpose: it keeps Lumi from
                    promising something you didn&rsquo;t mean.
                  </p>
                </div>

                <button type="submit" className={primary}>
                  Save and finish
                </button>
              </form>

              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <h3 className="text-sm font-medium text-gray-900">
                  Think of something later?
                </h3>
                <form action={submitIntakeRequest} className="mt-3 space-y-3">
                  <select name="topic" className={input} defaultValue="other">
                    <option value="greeting">The greeting</option>
                    <option value="tone">How it sounds</option>
                    <option value="never_say">Something it shouldn&rsquo;t say</option>
                    <option value="faq">A question it should be able to answer</option>
                    <option value="escalation">When it should transfer</option>
                    <option value="hours">Hours and availability</option>
                    <option value="other">Something else</option>
                  </select>
                  <textarea
                    name="body"
                    rows={3}
                    required
                    placeholder="Tell us what you'd like changed."
                    className={input}
                  />
                  <button type="submit" className={secondary}>
                    Send to our team
                  </button>
                </form>
              </div>
            </div>
          ) : null}
        </section>

        <p className="mt-6 text-center text-xs text-gray-400">
          Everything here can be changed later from your dashboard.
        </p>
      </div>
    </main>
  );
}

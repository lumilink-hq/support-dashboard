import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Meet Lumi — the AI receptionist that books jobs 24/7 | LumiLink",
  description:
    "Try Lumi, the AI phone receptionist for home-service companies. Book a service visit with our demo HVAC company — by phone or in your browser.",
};

// The browser widget is disabled for now — it can't book because a browser call
// has no dialed number to resolve the client (see docs/client-onboarding.md).
// The call-in demo below is the live path.
const PHONE_DISPLAY = "(213) 533-2469";
const PHONE_TEL = "+12135332469";

const SERVICES: { name: string; tag: string; emergency?: boolean }[] = [
  { name: "Service Call / Diagnostic", tag: "$89 call-out", emergency: true },
  { name: "AC Tune-Up", tag: "$99" },
  { name: "Furnace Tune-Up", tag: "$109" },
  { name: "AC Repair", tag: "$89 + quote", emergency: true },
  { name: "Heating / Furnace Repair", tag: "$89 + quote", emergency: true },
  { name: "New System Estimate", tag: "Free" },
];

const PROMPTS = [
  {
    n: 1,
    q: 'I’d like to book an AC tune-up for Thursday afternoon.',
    s: "Watch Lumi offer real open times and confirm the booking.",
  },
  {
    n: 2,
    q: "My heat is out and it’s freezing — this is an emergency.",
    s: "Lumi flags it as urgent and gets you the soonest slot.",
  },
  {
    n: 3,
    q: "How much is a furnace tune-up?",
    s: "Lumi answers from the price list — and can book it while you’re on.",
  },
];

function EmergencyTag() {
  return (
    <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 align-middle text-[11px] font-bold text-red-700">
      Emergency
    </span>
  );
}

export default function DemoPage() {
  return (
    <div className="min-h-full bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-5xl px-5">
        <header className="flex items-center justify-between py-5">
          <div className="flex items-center gap-2.5 font-bold tracking-tight">
            <span className="h-5 w-5 rounded-md bg-gradient-to-br from-blue-600 to-orange-500" />
            LumiLink
          </div>
          <span className="text-[13px] text-slate-500">Live demo</span>
        </header>

        {/* Hero */}
        <section className="relative mt-2 overflow-hidden rounded-3xl bg-gradient-to-br from-[#111a3a] via-[#1e3a8a] to-blue-600 px-8 py-14 text-white sm:px-10">
          <span className="inline-block rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-blue-200">
            AI receptionist for home services
          </span>
          <h1 className="mt-4 max-w-[16ch] text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            Lumi answers every call and books the job — 24/7.
          </h1>
          <p className="mt-3 max-w-[52ch] text-lg text-blue-100">
            No more missed calls or after-hours voicemail. Try Lumi right now with our demo HVAC
            company, <strong>Comfort Air</strong>. Book a service visit by phone or right here in
            your browser.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3.5">
            <a
              href={`tel:${PHONE_TEL}`}
              className="inline-flex items-center gap-2.5 rounded-xl bg-orange-500 px-5 py-3.5 text-[17px] font-bold text-white shadow-lg shadow-orange-500/30 hover:brightness-105"
            >
              📞 Call the demo line — {PHONE_DISPLAY}
            </a>
            <a
              href="#try"
              className="inline-flex items-center gap-2.5 rounded-xl border border-white/25 bg-white/10 px-5 py-3.5 text-[17px] font-bold text-white hover:bg-white/15"
            >
              See what to try
            </a>
          </div>
          <p className="mt-4 text-sm text-blue-200">
            Call from any phone — Lumi answers live and books the visit.
          </p>
        </section>

        {/* Try it */}
        <section id="try" className="mt-12 scroll-mt-6">
          <h2 className="text-2xl font-semibold tracking-tight">Try it — a few things to say</h2>
          <p className="mt-1.5 max-w-[60ch] text-slate-500">
            Call the demo line, then try one of these. Lumi checks real availability and books
            into a live demo calendar.
          </p>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {PROMPTS.map((p) => (
              <div key={p.n} className="rounded-2xl border border-slate-200 bg-white p-5">
                <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 font-bold text-blue-600">
                  {p.n}
                </div>
                <p className="text-slate-900">&ldquo;{p.q}&rdquo;</p>
                <p className="mt-2 text-sm text-slate-500">{p.s}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Prices */}
        <section className="mt-12">
          <h2 className="text-2xl font-semibold tracking-tight">
            Comfort Air — demo services &amp; pricing
          </h2>
          <p className="mt-1.5 text-slate-500">The sample catalog Lumi quotes and books from.</p>
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {SERVICES.map((s) => (
              <div
                key={s.name}
                className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-[18px] py-3.5"
              >
                <span className="font-semibold">
                  {s.name}
                  {s.emergency ? <EmergencyTag /> : null}
                </span>
                <span className="whitespace-nowrap font-bold text-blue-900">{s.tag}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Call callout */}
        <section className="mt-12">
          <div className="flex flex-wrap items-center justify-between gap-3.5 rounded-2xl border border-blue-100 bg-blue-50 px-[22px] py-5">
            <div>
              <div className="font-bold">Prefer to just call?</div>
              <div className="text-sm text-slate-500">Lumi is standing by on the demo line.</div>
            </div>
            <a
              href={`tel:${PHONE_TEL}`}
              className="text-2xl font-extrabold tracking-tight text-blue-900"
            >
              {PHONE_DISPLAY}
            </a>
          </div>
        </section>

        <footer className="mb-10 mt-14 border-t border-slate-200 pt-5 text-[13px] text-slate-500">
          <div>© LumiLink — AI reception for home-service companies.</div>
          <div className="mt-3.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800">
            This is a live demo. &ldquo;Comfort Air&rdquo; is a fictional company and all bookings go
            to a sandbox calendar — please don&rsquo;t enter real personal details you don&rsquo;t
            want stored in the demo.
          </div>
        </footer>
      </div>
    </div>
  );
}

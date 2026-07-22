import type { Metadata } from "next";
import ConvaiWidget from "./convai-widget";

export const metadata: Metadata = {
  title: "Talk to Lumi — Live Demo | Lumilink",
  description:
    "Try our AI phone agent live. Talk to Lumi right in your browser, or call the demo line — she books appointments, checks availability, and answers questions.",
};

// Set these in your environment (e.g. Railway / .env.local). Both are optional:
// the page degrades gracefully when either is missing.
//   NEXT_PUBLIC_ELEVENLABS_SCHEDULING_AGENT_ID = agent_xxx  (from ElevenLabs → Agents)
//   NEXT_PUBLIC_DEMO_PHONE_NUMBER              = +1XXXXXXXXXX (the demo Twilio number)
const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_SCHEDULING_AGENT_ID;
const DEMO_PHONE = process.env.NEXT_PUBLIC_DEMO_PHONE_NUMBER;

// Which demo tenant this page talks to. Overridable via ?client=<slug> so one
// page can serve per-client demo links (/demo?client=acme-hvac). The slug is
// passed to the widget as client_slug, which the scheduling tool uses to route
// the booking — the web analog of the dialed phone number. Slug routing is
// demo-only server-side, so this can't reach a real client's calendar.
const DEFAULT_CLIENT_SLUG =
  process.env.NEXT_PUBLIC_DEMO_CLIENT_SLUG || "comfort-air-demo";

/** Renders +15551234567 as "+1 (555) 123-4567" for US/E.164 numbers; else as-is. */
function formatPhone(raw: string): string {
  const m = raw.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : raw;
}

export default async function DemoPage({
  searchParams,
}: {
  // Next 16: searchParams is async.
  searchParams: Promise<{ client?: string }>;
}) {
  const { client } = await searchParams;
  const clientSlug = (client || DEFAULT_CLIENT_SLUG).trim();

  return (
    <main className="min-h-full bg-gradient-to-b from-slate-50 to-white text-slate-900">
      <div className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Live demo
        </span>

        <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
          Talk to Lumi
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-600">
          Lumi is our AI scheduling agent. She answers the phone, checks
          real-time availability, books appointments, and captures leads after
          hours — for a sample home-services business, Comfort Air. Try her out
          below.
        </p>

        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {/* In-browser voice */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold">Talk in your browser</h2>
            {AGENT_ID ? (
              <>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  Tap the microphone button in the bottom-right corner, allow
                  mic access, and start talking. No download, no phone call.
                </p>
                <ConvaiWidget
                  agentId={AGENT_ID}
                  dynamicVariables={{ client_slug: clientSlug }}
                />
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-slate-500">
                The in-browser demo is being set up and will be available here
                shortly.
              </p>
            )}
          </section>

          {/* Call a number */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
              </svg>
            </div>
            <h2 className="mt-4 text-lg font-semibold">Or call the demo line</h2>
            {DEMO_PHONE ? (
              <>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  Prefer a real phone call? Dial the number below and Lumi will
                  pick up.
                </p>
                <a
                  href={`tel:${DEMO_PHONE}`}
                  className="mt-4 inline-flex items-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
                >
                  {formatPhone(DEMO_PHONE)}
                </a>
              </>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-slate-500">
                A demo phone line will be listed here soon.
              </p>
            )}
          </section>
        </div>

        {/* Suggestions */}
        <section className="mt-12 rounded-2xl border border-slate-200 bg-slate-50 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Things to try
          </h2>
          <ul className="mt-4 space-y-3 text-sm text-slate-700">
            <li className="flex gap-3">
              <span aria-hidden>💬</span>
              <span>&ldquo;My AC stopped cooling — can someone come out?&rdquo;</span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden>💬</span>
              <span>&ldquo;What times are open this week for a furnace tune-up?&rdquo;</span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden>💬</span>
              <span>&ldquo;How much is a service call?&rdquo;</span>
            </li>
            <li className="flex gap-3">
              <span aria-hidden>💬</span>
              <span>&ldquo;Book me the first available appointment.&rdquo;</span>
            </li>
          </ul>
        </section>

        <p className="mt-10 text-xs leading-relaxed text-slate-400">
          This is a demonstration agent for a sample business. Appointments
          booked here are not real. Powered by Lumilink.
        </p>
      </div>
    </main>
  );
}

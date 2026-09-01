// CSS mockups of the dashboard, replacing real screenshots on marketing pages.
//
// WHY THIS EXISTS (2026-08-31). The screenshots this replaces had two
// problems: they needed re-capturing by hand every time the UI or the seed
// data changed, and some of them (proof-tsunami*.png, proof-budclub-crop.jpg)
// showed a real client's name and real numbers on a public marketing page.
// A hand-built mockup has neither problem — it's markup, so it never goes
// stale, and every name and number in it is invented here, not pulled from
// a live account.
//
// The "two live stores" claim on /solutions/ecommerce (named clients running
// a real support line) was dropped for the same reason, not just re-skinned:
// see components/marketing/storefront-mockups.tsx and that page's copy,
// which no longer names or counts specific clients.
//
// Visual language matches the real dashboard as closely as a static mockup
// reasonably can (app/(dashboard)/appointments, /conversations,
// /review-queue): same KPI-card shape, same colored day-chip borders, same
// pill badges. Same glow-frame chrome the screenshots used, so
// swapping one for the other on a page doesn't change how the section reads.

/** Exported so components/marketing/storefront-mockups.tsx can reuse the same glow-frame chrome. */
export function MockupFrame({
  caption,
  children,
  className = "",
}: {
  caption: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="relative">
        <div
          aria-hidden
          className="absolute -inset-3 -z-10 rounded-[1.75rem] bg-gradient-to-br from-blue-200 via-indigo-100 to-amber-100 opacity-80 blur-2xl"
        />
        <div
          aria-hidden
          className="overflow-hidden rounded-xl border border-gray-200 bg-white p-5 shadow-xl shadow-gray-900/10 sm:p-6"
        >
          {children}
        </div>
      </div>
      <p className="mt-3 flex items-center gap-2 text-xs font-medium text-gray-500">
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"
        />
        {caption}
      </p>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold text-gray-900">{value}</p>
      {sub ? <p className="text-[10px] text-gray-500">{sub}</p> : null}
    </div>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "green" | "amber" | "gray" | "red";
}) {
  const tones = {
    green: "bg-green-50 text-green-700",
    amber: "bg-amber-50 text-amber-700",
    gray: "bg-gray-100 text-gray-500",
    red: "bg-red-50 text-red-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

const WEEK = [
  {
    day: "Mon",
    events: [{ time: "9:00a", name: "Priya Anand", emergency: false }],
  },
  {
    day: "Tue",
    events: [
      { time: "11:30a", name: "Marcus Webb", emergency: false },
      { time: "2:00p", name: "Elena Torres", emergency: false },
    ],
  },
  {
    day: "Wed",
    events: [{ time: "8:15a", name: "Devon Clarke", emergency: true }],
    today: true,
  },
  { day: "Thu", events: [{ time: "1:00p", name: "Sofia Marin", emergency: false }] },
  {
    day: "Fri",
    events: [
      { time: "10:00a", name: "Owen Baptiste", emergency: false },
      { time: "3:30p", name: "Grace Lindqvist", emergency: false },
    ],
  },
  { day: "Sat", events: [] },
  { day: "Sun", events: [] },
];

/** Hero-shot mockup: KPI row + week strip, matching the original crop. */
export function AppointmentsMockup({
  caption,
  className,
}: {
  caption: string;
  className?: string;
}) {
  return (
    <MockupFrame caption={caption} className={className}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Booked revenue" value="$4,860" sub="committed" />
        <Kpi label="Booked" value="12" sub="68% of calls" />
        <Kpi label="Avg job" value="$405" />
        <Kpi label="After-hours" value="5" sub="captured" />
      </div>

      <div className="mt-4 grid grid-cols-7 gap-1.5">
        {WEEK.map((d) => (
          <div
            key={d.day}
            className={`min-h-16 rounded-md border p-1.5 ${
              d.today ? "border-gray-900" : "border-gray-200"
            }`}
          >
            <p className="text-[9px] font-semibold text-gray-600">{d.day}</p>
            <div className="mt-1 space-y-1">
              {d.events.map((e) => (
                <div
                  key={e.time}
                  className={`rounded border-l-2 px-1 py-0.5 text-[8px] leading-tight ${
                    e.emergency
                      ? "border-red-500 bg-red-50 text-red-700"
                      : "border-blue-400 bg-blue-50 text-blue-700"
                  }`}
                >
                  <div className="font-medium">{e.time}</div>
                  <div className="truncate">{e.name}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </MockupFrame>
  );
}

const CONVERSATIONS = [
  {
    name: "Priya Anand",
    subtitle: "Phone call",
    order: null,
    status: "Resolved" as const,
    time: "2m ago",
  },
  {
    name: "Marcus Webb",
    subtitle: "Where's my order #10482",
    order: "10482",
    status: "Resolved" as const,
    time: "18m ago",
  },
  {
    name: "Elena Torres",
    subtitle: "Phone call",
    order: null,
    status: "Escalated" as const,
    time: "41m ago",
  },
  {
    name: "Devon Clarke",
    subtitle: "Refund on order #10361",
    order: "10361",
    status: "Open" as const,
    time: "1h ago",
  },
];

const CONVERSATION_TONE = {
  Resolved: "green",
  Escalated: "amber",
  Open: "gray",
} as const;

/** Recent-calls list, matching /conversations' row layout. */
export function ConversationsMockup({
  caption,
  className,
}: {
  caption: string;
  className?: string;
}) {
  return (
    <MockupFrame caption={caption} className={className}>
      <ul className="divide-y divide-gray-100">
        {CONVERSATIONS.map((c) => (
          <li key={c.name} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Pill tone="gray">Voice</Pill>
                <span className="truncate text-sm font-medium text-gray-900">
                  {c.name}
                </span>
              </div>
              <p className="truncate text-xs text-gray-500">{c.subtitle}</p>
            </div>
            {c.order ? (
              <span className="hidden shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 sm:inline-block">
                #{c.order}
              </span>
            ) : null}
            <Pill tone={CONVERSATION_TONE[c.status]}>{c.status}</Pill>
            <span className="w-12 shrink-0 text-right text-[10px] text-gray-400">
              {c.time}
            </span>
          </li>
        ))}
      </ul>
    </MockupFrame>
  );
}

const TICKETS = [
  {
    ticketNo: 1042,
    reason: "Callback requested",
    status: "Pending" as const,
    priority: "Normal" as const,
    due: "due in 2h",
    callback: "(555) 019-2231",
    customer: "Grace Lindqvist",
    order: "10510",
  },
  {
    ticketNo: 1041,
    reason: "Abnormal order status",
    status: "Pending" as const,
    priority: "High" as const,
    due: "due in 40m",
    callback: null,
    customer: "Owen Baptiste",
    order: "10497",
  },
];

/** Callback/flag queue, matching /review-queue's ticket-card layout. */
export function ReviewQueueMockup({
  caption,
  className,
}: {
  caption: string;
  className?: string;
}) {
  return (
    <MockupFrame caption={caption} className={className}>
      <div className="space-y-3">
        {TICKETS.map((t) => (
          <div key={t.ticketNo} className="rounded-lg border border-gray-200 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">
                #{t.ticketNo}
              </span>
              <Pill tone="amber">{t.reason}</Pill>
              <Pill tone="gray">{t.status}</Pill>
              {t.priority === "High" ? <Pill tone="red">High</Pill> : null}
              <span className="ml-auto text-[10px] text-gray-400">{t.due}</span>
            </div>

            {t.callback ? (
              <div className="mt-2">
                <span
                  aria-hidden
                  className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-2 py-1 font-mono text-[11px] font-medium text-white"
                >
                  ☎ {t.callback}
                </span>
              </div>
            ) : null}

            <p className="mt-2 flex items-center gap-2 text-xs text-gray-500">
              <span className="truncate">{t.customer}</span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">
                #{t.order}
              </span>
            </p>

            <div className="mt-3 flex gap-2" aria-hidden>
              <span className="rounded-md bg-gray-900 px-2.5 py-1 text-[11px] font-medium text-white">
                Resolve
              </span>
              <span className="rounded-md border border-gray-300 px-2.5 py-1 text-[11px] font-medium text-gray-700">
                Dismiss
              </span>
            </div>
          </div>
        ))}
      </div>
    </MockupFrame>
  );
}

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ApptStatusBadge, EmergencyChip } from "@/components/status-badge";
import { formatMoney } from "@/lib/format";
import type { AppointmentRow } from "@/lib/types";

const DEFAULT_TZ = "America/Los_Angeles";

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}
function localDateStr(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
function localTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
function localDow(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
    .format(new Date(iso))
    .slice(0, 3)
    .toLowerCase();
}
function localMinutes(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  return +m.hour * 60 + +m.minute;
}
function isAfterHours(iso: string, tz: string, hours: Record<string, string[]>): boolean {
  const win = hours[localDow(iso, tz)];
  if (!win || win.length < 2) return true; // closed day => after-hours
  const [oh, om] = win[0].split(":").map(Number);
  const [ch, cm] = win[1].split(":").map(Number);
  const t = localMinutes(iso, tz);
  return !(t >= oh * 60 + om && t < ch * 60 + cm);
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold text-gray-900">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-gray-500">{sub}</p> : null}
    </div>
  );
}

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
  const weekOffset = Number.isFinite(Number(week)) ? parseInt(week ?? "0", 10) : 0;

  const supabase = await createClient();

  const { data: client } = await supabase
    .from("clients")
    .select("settings")
    .maybeSingle();
  const scheduling = ((client?.settings as any)?.scheduling ?? {}) as {
    timezone?: string;
    hours?: Record<string, string[]>;
  };
  const tz = scheduling.timezone ?? DEFAULT_TZ;
  const hours = scheduling.hours ?? {};

  const { data: apptData, error } = await supabase
    .from("appointments")
    .select(
      "id, conversation_id, service_name, customer_name, customer_phone, service_address, is_emergency, starts_at, ends_at, status, source, price_type, currency, committed_amount, estimated_value, final_value, revenue_status, created_at",
    )
    .order("starts_at", { ascending: true });
  const appts = (apptData ?? []) as AppointmentRow[];

  const { count: leadCount } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("booking_outcome", "lead_only");

  // KPIs over live (non-cancelled) appointments.
  const live = appts.filter((a) => a.status !== "cancelled" && a.status !== "no_show");
  const committed = live.reduce((s, a) => s + num(a.committed_amount), 0);
  const pipeline = live.reduce((s, a) => s + num(a.estimated_value), 0);
  const realized = live
    .filter((a) => a.status === "completed")
    .reduce((s, a) => s + num(a.final_value), 0);
  const emergencies = live.filter((a) => a.is_emergency).length;
  const afterHours = live.filter((a) => isAfterHours(a.created_at, tz, hours)).length;
  const avgJob = live.length ? committed / live.length : 0;
  const leads = leadCount ?? 0;
  const conversion = live.length + leads > 0
    ? Math.round((live.length / (live.length + leads)) * 100)
    : 0;

  // Week grid (Mon-Sun), navigable via ?week=offset.
  const todayStr = localDateStr(new Date().toISOString(), tz);
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const anchor = Date.UTC(ty, tm - 1, td);
  const dow = new Date(anchor).getUTCDay(); // 0 Sun..6 Sat
  const mondayOffset = (dow + 6) % 7;
  const weekStart = anchor - mondayOffset * 86_400_000 + weekOffset * 7 * 86_400_000;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart + i * 86_400_000);
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return {
      dateStr: `${y}-${mo}-${da}`,
      label: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d),
      dayNum: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      isToday: `${y}-${mo}-${da}` === todayStr,
    };
  });
  const byDay: Record<string, AppointmentRow[]> = {};
  for (const a of live) {
    const key = localDateStr(a.starts_at, tz);
    (byDay[key] ??= []).push(a);
  }

  const nowMs = Date.now();
  const upcoming = appts
    .filter((a) => new Date(a.starts_at).getTime() >= nowMs && a.status !== "cancelled")
    .slice(0, 40);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Appointments</h1>
        <span className="text-sm text-gray-500">{live.length} booked</span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Jobs booked by the agent, the revenue they represent, and the week ahead.
      </p>

      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Couldn&apos;t load appointments: {error.message}
        </div>
      ) : null}

      {/* Revenue KPIs */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Booked revenue" value={formatMoney(committed, "USD")} sub="committed" />
        <Kpi label="Pipeline" value={formatMoney(pipeline, "USD")} sub="est. quotes" />
        <Kpi label="Avg job" value={formatMoney(avgJob, "USD")} />
        <Kpi label="Booked" value={String(live.length)} sub={`${conversion}% of calls`} />
        <Kpi label="After-hours" value={String(afterHours)} sub="captured" />
        <Kpi label="Emergencies" value={String(emergencies)} />
      </div>

      {/* Week calendar */}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          Week of {days[0].dayNum}
        </h2>
        <div className="flex gap-1">
          <Link
            href={`/appointments?week=${weekOffset - 1}`}
            className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
          >
            ← Prev
          </Link>
          {weekOffset !== 0 ? (
            <Link href="/appointments" className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100">
              Today
            </Link>
          ) : null}
          <Link
            href={`/appointments?week=${weekOffset + 1}`}
            className="rounded-md px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
          >
            Next →
          </Link>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-7">
        {days.map((d) => {
          const dayAppts = (byDay[d.dateStr] ?? []).sort(
            (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
          );
          return (
            <div
              key={d.dateStr}
              className={`min-h-28 rounded-lg border bg-white p-2 ${
                d.isToday ? "border-gray-900" : "border-gray-200"
              }`}
            >
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-gray-700">{d.label}</span>
                <span className="text-xs text-gray-400">{d.dayNum}</span>
              </div>
              <div className="space-y-1">
                {dayAppts.length === 0 ? (
                  <p className="text-[11px] text-gray-300">—</p>
                ) : (
                  dayAppts.map((a) => (
                    <Link
                      key={a.id}
                      href={a.conversation_id ? `/conversations/${a.conversation_id}` : "#"}
                      className={`block rounded border-l-2 px-1.5 py-1 text-[11px] ${
                        a.is_emergency
                          ? "border-red-500 bg-red-50"
                          : "border-blue-400 bg-blue-50"
                      }`}
                    >
                      <div className="font-medium text-gray-900">{localTime(a.starts_at, tz)}</div>
                      <div className="truncate text-gray-600">
                        {a.customer_name || "—"}
                      </div>
                      <div className="truncate text-gray-500">{a.service_name || ""}</div>
                    </Link>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Upcoming list */}
      <h2 className="mt-8 text-sm font-semibold text-gray-900">Upcoming</h2>
      {upcoming.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-400">
          No upcoming appointments.
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="hidden px-3 py-2 font-medium md:table-cell">Address</th>
                <th className="px-3 py-2 font-medium">Revenue</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {upcoming.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                    {localDateStr(a.starts_at, tz)} · {localTime(a.starts_at, tz)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-900">{a.customer_name || "—"}</span>
                      {a.is_emergency ? <EmergencyChip /> : null}
                    </div>
                    {a.customer_phone ? (
                      <div className="text-xs text-gray-400">{a.customer_phone}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-gray-700">{a.service_name || "—"}</td>
                  <td className="hidden max-w-[16rem] truncate px-3 py-2 text-gray-500 md:table-cell">
                    {a.service_address || "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                    {formatMoney(num(a.committed_amount), a.currency ?? "USD")}
                    {a.price_type === "quote" ? (
                      <span className="ml-1 text-xs text-gray-400">+ quote</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    {a.conversation_id ? (
                      <Link href={`/conversations/${a.conversation_id}`}>
                        <ApptStatusBadge status={a.status} />
                      </Link>
                    ) : (
                      <ApptStatusBadge status={a.status} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

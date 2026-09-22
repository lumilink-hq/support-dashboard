import Link from "next/link";
import { SeoLocked } from "@/components/seo/locked";
import { getSeoAccess } from "@/lib/seo-access";
import { createClient } from "@/lib/supabase/server";
import { generateReportNow } from "./actions";

type Row = {
  id: string;
  period_start: string;
  content: { period?: { label?: string } } | null;
  email_status: string;
  created_at: string;
};

const EMAIL_LABELS: Record<string, string> = {
  sent: "Emailed",
  pending: "Email pending",
  failed: "Email failed, retrying",
  skipped_no_sender: "Not emailed",
  skipped_no_recipient: "Not emailed",
};

export default async function SeoReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const access = await getSeoAccess();
  if (!access.allowed) return <SeoLocked state={access.state} />;

  const { notice, error: actionError } = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("seo_reports")
    .select("id, period_start, content, email_status, created_at")
    .order("period_start", { ascending: false })
    .limit(36);
  const reports = (data ?? []) as Row[];

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Monthly SEO reports</h1>
        <Link href="/seo" className="text-sm text-blue-700 underline">Back to SEO</Link>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        A report is prepared on the 1st of each month covering the month before: rankings, profile results, the work that went live and what is queued next.
      </p>

      <form action={generateReportNow} className="mt-4">
        <button
          type="submit"
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          Prepare last month&apos;s report now
        </button>
        <span className="ml-2 text-xs text-gray-500">Takes up to a minute. It won&apos;t email a report that already went out.</span>
      </form>
      {notice ? <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</div> : null}
      {actionError ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{actionError}</div> : null}

      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Couldn&apos;t load reports: {error.message}
        </div>
      ) : reports.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-400">
          No report yet. The first one is prepared on the 1st of next month.
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
          {reports.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <Link href={`/seo/reports/${r.id}`} className="text-sm font-medium text-gray-900 hover:underline">
                {r.content?.period?.label ?? r.period_start}
              </Link>
              <span className="flex items-center gap-3 text-xs text-gray-500">
                {EMAIL_LABELS[r.email_status] ?? r.email_status}
                <a href={`/seo/reports/${r.id}/pdf`} className="text-blue-700 underline">PDF</a>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

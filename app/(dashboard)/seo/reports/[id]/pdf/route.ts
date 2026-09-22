import { NextResponse } from "next/server";
import { getSeoAccess } from "@/lib/seo-access";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hands the caller a short-lived signed link to their report's PDF.
 *
 * Runs under the caller's own session, never the service key: the seo_reports
 * RLS policy decides whether the row is theirs, and 0057's storage policy
 * decides whether the file is (folder = their client id). A report id that
 * isn't theirs finds no row and gets a 404, the same as one that doesn't exist.
 */
export async function GET(req: Request, ctx: RouteContext<"/seo/reports/[id]/pdf">) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new NextResponse("Not found", { status: 404 });

  if (!(await getSeoAccess()).allowed) return new NextResponse("Not found", { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const { data: report } = await supabase
    .from("seo_reports")
    .select("pdf_path, period_start")
    .eq("id", id)
    .maybeSingle();
  if (!report?.pdf_path) return new NextResponse("Not found", { status: 404 });

  const { data, error } = await supabase.storage
    .from("seo-reports")
    .createSignedUrl(report.pdf_path as string, 60, {
      download: `seo-report-${String(report.period_start).slice(0, 7)}.pdf`,
    });
  if (error || !data?.signedUrl) return new NextResponse("The PDF isn't available.", { status: 502 });

  return NextResponse.redirect(data.signedUrl);
}

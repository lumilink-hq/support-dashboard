import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next 16: the `middleware` convention was renamed to `proxy` (nodejs runtime).
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Run on all routes except static assets and image files.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

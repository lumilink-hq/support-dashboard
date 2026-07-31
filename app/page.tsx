// "/" — the public front door.
//
// Signed OUT: the marketing landing page.
// Signed IN:  straight to the dashboard. Someone who has already bought doesn't
//             want a sales pitch every time they type the bare domain.
//
// The escape hatch is /home, which renders the same page without redirecting,
// so a signed-in user can still look at the marketing site (linked from the
// sidebar). The markup lives in components/marketing/landing.tsx precisely so
// these two routes cannot drift apart.
//
// This route is the CANONICAL one — /home is noindex. Two URLs serving
// identical content split the ranking signal and neither wins.

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Landing, LANDING_METADATA } from "@/components/marketing/landing";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = LANDING_METADATA;

export default async function Home() {
  // A Supabase outage must not take the marketing site down with it: on error
  // we fall through and render the public page rather than 500.
  let signedIn = false;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    signedIn = Boolean(user);
  } catch {
    signedIn = false;
  }

  if (signedIn) redirect("/conversations");

  return <Landing />;
}

// "/home" — the same landing page, but it never redirects.
//
// WHY IT EXISTS. "/" sends signed-in users to the dashboard, which is right for
// the bare domain but makes the marketing site unreachable for anyone with a
// session — including you, whenever you want to show someone the product or
// check a copy change without signing out.
//
// NOINDEX ON PURPOSE. This serves byte-identical content to "/". Letting search
// engines index both splits the ranking signal between two URLs and neither
// wins. "/" is canonical; this is the staff door.

import type { Metadata } from "next";
import { Landing, LANDING_METADATA } from "@/components/marketing/landing";

export const metadata: Metadata = {
  ...LANDING_METADATA,
  robots: { index: false, follow: false },
  alternates: { canonical: "/" },
};

export default function HomePage() {
  // Pass our own path so the wordmark keeps you here rather than bouncing you
  // to "/", which would redirect a signed-in visitor into the dashboard — the
  // exact thing they were trying to get away from.
  return <Landing homeHref="/home" />;
}

import { redirect } from "next/navigation";

// Unauthenticated requests are bounced to /login by the proxy; everyone else
// lands on the conversations view.
//
// The Next.js marketing landing page lives at /preview while the Wix site is
// still the public front door. See app/preview/page.tsx for how to promote it
// to this route.
export default function Home() {
  redirect("/conversations");
}

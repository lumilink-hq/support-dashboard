// "/demo" — the canonical demo URL, so shared links stay short and stable.
//
// It serves the customer-service demo at /demo/orders. The HVAC/scheduling demo
// is parked at /demo/hvac: unlinked, noindex, and carrying two unfixed problems
// (it advertises Tsunami's live number, and comfort-air-demo holds an
// undiallable 555 number).
//
// A redirect rather than moving the page here, so anything already pointing at
// /demo/orders keeps working and swapping which demo is canonical stays a
// one-line change.

import { redirect } from "next/navigation";

export default function DemoPage() {
  redirect("/demo/orders");
}

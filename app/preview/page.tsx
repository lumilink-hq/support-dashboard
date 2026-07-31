// "/preview" — retired.
//
// The landing page was parked here while the Wix site was the front door. It
// now lives at "/" (public, canonical) with "/home" as the always-renders
// version for signed-in users. This redirect exists only so links shared during
// the review period don't 404.
//
// Safe to delete once nobody is using those links.

import { redirect } from "next/navigation";

export default function PreviewRedirect() {
  redirect("/home");
}

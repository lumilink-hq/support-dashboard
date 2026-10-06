import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site-pages";

// Served at /robots.txt. Dashboard routes need no Disallow: they redirect
// signed-out crawlers to /login. Noindex pages must stay crawlable, or Google
// never sees their noindex tag.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/auth/"],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}

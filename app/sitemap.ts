import type { MetadataRoute } from "next";
import { SITEMAP_PATHS, siteOrigin } from "@/lib/site-pages";

// Served at /sitemap.xml. The page list lives in lib/site-pages.ts. No
// lastModified: Google ignores it unless it's accurate, and we don't track it.
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return SITEMAP_PATHS.map((path) => ({
    url: path === "/" ? origin : origin + path,
  }));
}

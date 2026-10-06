import type { MetadataRoute } from "next";
import { getAllPosts } from "@/lib/blog";
import { SITEMAP_PATHS, siteOrigin } from "@/lib/site-pages";

// Served at /sitemap.xml. The fixed pages live in lib/site-pages.ts; blog posts
// come from content/blog. No lastModified on the fixed pages: Google ignores it
// unless it's accurate, and we don't track it. Posts have real dates.
// /blog itself is listed only once a post exists (it's noindex while empty).
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  const pages = SITEMAP_PATHS.map((path) => ({
    url: path === "/" ? origin : origin + path,
  }));
  const posts = getAllPosts();
  if (posts.length === 0) return pages;
  return [
    ...pages,
    {
      url: `${origin}/blog`,
      // The latest date any post was published or updated.
      lastModified: posts.map((p) => p.updated ?? p.date).sort().at(-1),
    },
    ...posts.map((p) => ({
      url: `${origin}/blog/${p.slug}`,
      lastModified: p.updated ?? p.date,
    })),
  ];
}

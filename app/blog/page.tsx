// "/blog" — the article index. Public (the "/blog" prefix in
// lib/route-access.ts). Posts live in content/blog; see lib/blog.ts.
//
// Noindex while there are no posts: an empty listing is a thin page, and the
// sitemap leaves /blog out until the first post exists.

import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/shell";
import { Eyebrow, Section } from "@/components/marketing/blocks";
import { formatPostDate, getAllPosts } from "@/lib/blog";
import { withSeoOverrides } from "@/lib/seo-overrides";

export function generateMetadata(): Metadata {
  const hasPosts = getAllPosts().length > 0;
  return withSeoOverrides("/blog", {
    title: "Blog | LumiLink",
    description:
      "Practical guides on answering every customer, getting found on Google and showing up in AI search, for service businesses and online stores.",
    alternates: { canonical: "/blog" },
    ...(hasPosts ? {} : { robots: { index: false, follow: true } }),
  });
}

export default function BlogIndexPage() {
  const posts = getAllPosts();

  return (
    <MarketingShell>
      <Section className="pb-10 pt-16 md:pt-24">
        <div className="max-w-2xl">
          <Eyebrow>Blog</Eyebrow>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
            Guides For Getting Found And Never Missing A Customer
          </h1>
        </div>
      </Section>

      <Section className="pb-20">
        {posts.length === 0 ? (
          <p className="max-w-2xl text-gray-600">
            The first articles are on their way. Check back soon.
          </p>
        ) : (
          <ul className="max-w-3xl divide-y divide-gray-200 border-t border-gray-200">
            {posts.map((post) => (
              <li key={post.slug} className="py-8">
                <p className="text-sm text-gray-500">
                  <time dateTime={post.date}>{formatPostDate(post.date)}</time>
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-gray-900">
                  <Link href={`/blog/${post.slug}`} className="hover:text-lumi-700">
                    {post.title}
                  </Link>
                </h2>
                <p className="mt-3 leading-relaxed text-gray-600">{post.description}</p>
                <Link
                  href={`/blog/${post.slug}`}
                  className="mt-4 inline-block text-sm font-medium text-lumi-700 hover:text-lumi-600"
                  aria-label={`Read: ${post.title}`}
                >
                  Read the article →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </MarketingShell>
  );
}

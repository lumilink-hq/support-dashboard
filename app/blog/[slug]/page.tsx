// "/blog/<slug>" — one article from content/blog/<slug>.html (lib/blog.ts).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { ClosingCta, Section } from "@/components/marketing/blocks";
import { MarketingShell } from "@/components/marketing/shell";
import { formatPostDate, getPost } from "@/lib/blog";
import { blogPostingJsonLd } from "@/lib/structured-data";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = getPost((await params).slug);
  if (!post) return {};
  return {
    title: `${post.title} | LumiLink`,
    description: post.description,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      url: `/blog/${post.slug}`,
      publishedTime: post.date,
      ...(post.updated ? { modifiedTime: post.updated } : {}),
      ...(post.image ? { images: [{ url: post.image, alt: post.imageAlt ?? "" }] } : {}),
    },
  };
}

export default async function BlogPostPage({ params }: Props) {
  const post = getPost((await params).slug);
  if (!post) notFound();

  return (
    <MarketingShell>
      <JsonLd data={blogPostingJsonLd(post)} />
      <Section className="pb-16 pt-12 md:pt-16">
        <article className="mx-auto max-w-2xl">
          <Link href="/blog" className="text-sm font-medium text-lumi-700 hover:text-lumi-600">
            ← All articles
          </Link>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
            {post.title}
          </h1>
          <p className="mt-4 text-sm text-gray-500">
            <time dateTime={post.date}>{formatPostDate(post.date)}</time>
            {post.updated && (
              <>
                {" · Updated "}
                <time dateTime={post.updated}>{formatPostDate(post.updated)}</time>
              </>
            )}
          </p>
          {post.image && (
            // A plain <img>: module 16's images live in Supabase storage, and
            // next/image would need that host in remotePatterns for one tag.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.image}
              alt={post.imageAlt ?? ""}
              className="mt-8 w-full rounded-lg border border-gray-200"
            />
          )}
          {/* Safe: lib/blog.ts refuses any body outside the tag whitelist,
              with no attributes, so there's no way to carry script or links. */}
          <div className="blog-body mt-8" dangerouslySetInnerHTML={{ __html: post.html }} />
        </article>
      </Section>
      <ClosingCta
        heading="Answer Every Customer. Get Found Everywhere."
        body="LumiLink answers your calls and website visitors, and gets you found on Google and in AI search."
      />
    </MarketingShell>
  );
}

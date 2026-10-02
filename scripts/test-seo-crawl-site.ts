// =============================================================================
// test-seo-crawl-site.ts — unit tests for module 24's site-wide crawl helpers
// (supabase/functions/seo-crawl/site.ts) and the homepage-only page rules.
//
//   npx tsx scripts/test-seo-crawl-site.ts
//
// No network, no Deno, no database.
// =============================================================================

import { pagePath, summarizeFindings } from "../lib/seo-portal";
import { auditPage } from "../supabase/functions/seo-crawl/lib.ts";
import {
  auditSite,
  extractCanonicals,
  extractLinks,
  isCrawlable,
  isNoindex,
  type LinkCheck,
  type PageFact,
  parseSitemap,
  sameSite,
  type SiteInput,
  sitemapPages,
  sitemapsFromRobots,
} from "../supabase/functions/seo-crawl/site.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${got === undefined ? "" : `  (got: ${JSON.stringify(got)})`}`);
  }
}

const S = "https://www.acme.com";

function page(path: string, over: Partial<PageFact> = {}): PageFact {
  return {
    url: `${S}${path}`,
    status_code: 200,
    final_url: null,
    redirect_hops: 0,
    in_sitemap: true,
    is_root: path === "/",
    title: `Title ${path}`,
    meta_description: `Description for ${path}`,
    canonicals: [`${S}${path}`],
    noindex: false,
    internal_links: [],
    outbound_links: [],
    ...over,
  };
}

function check(url: string, status: number, over: Partial<LinkCheck> = {}): LinkCheck {
  return { url, status_code: status, final_url: null, redirect_hops: 0, error: null, ...over };
}

function site(pages: PageFact[], checks: LinkCheck[] = [], over: Partial<SiteInput> = {}): SiteInput {
  return { siteHost: "www.acme.com", pages, checks, pageLimit: 100, truncated: false, sitemapFound: true, sitemapUrlCount: pages.length, ...over };
}

const types = (fs: { finding_type: string }[]) => fs.map((f) => f.finding_type);
const of = (fs: ReturnType<typeof auditSite>, t: string) => fs.filter((f) => f.finding_type === t);

console.log("\nhosts and crawlable URLs");
{
  ok("www and bare are the same site", sameSite("https://acme.com/x", "www.acme.com") && sameSite("http://WWW.ACME.COM/", "acme.com"));
  ok("a subdomain is another site", !sameSite("https://shop.acme.com/", "www.acme.com"));
  ok("garbage is not the site", !sameSite("not a url", "acme.com"));
  ok("another port is another site", !sameSite("http://localhost:8796/x", "localhost:8795") && sameSite("http://localhost:8795/x", "localhost:8795"));
  ok("pages are crawlable", isCrawlable(`${S}/services/drains`));
  ok("files and carts are not", !isCrawlable(`${S}/menu.pdf`) && !isCrawlable(`${S}/cart`) && !isCrawlable("ftp://acme.com/x"));
}

console.log("\nsitemaps");
{
  const robots = "User-agent: *\nDisallow:\nSitemap: https://www.acme.com/sitemap_index.xml\nsitemap:   https://www.acme.com/extra.xml\nSitemap: /relative.xml\n";
  ok("Sitemap lines read, case-insensitive, relative ignored", JSON.stringify(sitemapsFromRobots(robots)) === JSON.stringify(["https://www.acme.com/sitemap_index.xml", "https://www.acme.com/extra.xml"]));
  ok("no robots → none", sitemapsFromRobots(null).length === 0);

  const index = parseSitemap(`<?xml version="1.0"?><sitemapindex xmlns="x"><sitemap><loc>https://www.acme.com/s1.xml</loc></sitemap><sitemap><loc> https://www.acme.com/s2.xml </loc></sitemap></sitemapindex>`);
  ok("an index is recognised with its children", index.kind === "index" && index.locs.length === 2 && index.locs[1] === "https://www.acme.com/s2.xml");
  const set = parseSitemap(`<urlset><url><loc><![CDATA[https://www.acme.com/a?x=1&amp;y=2]]></loc></url><url><loc>https://www.acme.com/b</loc></url></urlset>`);
  ok("a urlset with CDATA and entities", set.kind === "urlset" && set.locs[0] === "https://www.acme.com/a?x=1&y=2", set);
  ok("HTML or nothing is unknown", parseSitemap("<html>404</html>").kind === "unknown" && parseSitemap(null).kind === "unknown");

  const pages = sitemapPages(
    ["https://acme.com/a/", "https://www.acme.com/a", "https://other.com/x", "https://www.acme.com/file.pdf", "https://www.acme.com/b?utm_source=x", "https://www.acme.com/c"],
    "www.acme.com",
  );
  ok("same site, crawlable, normalised, de-duplicated", JSON.stringify(pages) === JSON.stringify(["https://acme.com/a", "https://www.acme.com/a", "https://www.acme.com/b", "https://www.acme.com/c"]), pages);
  ok("capped", sitemapPages(Array.from({ length: 50 }, (_, i) => `${S}/p${i}`), "www.acme.com", 10).length === 10);
}

console.log("\npage facts");
{
  const html = `<a href="/services/">Services</a><a href="https://acme.com/about#team">About</a><a href="#top">Top</a>
    <a href="mailto:x@y.z">Mail</a><a href="tel:123">Call</a><a href="https://partner.org/page">Partner</a>
    <a href="/brochure.pdf">PDF</a><a href="/services">Again</a><a href="${S}/">Self</a><a href="/x?utm_source=nl">Tracked</a>`;
  const links = extractLinks(html, `${S}/`, "www.acme.com");
  ok("internal: resolved, normalised, de-duplicated, no self/files/anchors", JSON.stringify(links.internal) === JSON.stringify([`${S}/services`, "https://acme.com/about", `${S}/x`]), links.internal);
  ok("outbound: other sites only", JSON.stringify(links.outbound) === JSON.stringify(["https://partner.org/page"]), links.outbound);

  const canon = extractCanonicals(`<link rel="canonical" href="/a/"><link href="https://www.acme.com/b" rel='canonical'>`, `${S}/a`);
  ok("canonicals resolved and normalised, every one kept", JSON.stringify(canon) === JSON.stringify([`${S}/a`, `${S}/b`]), canon);

  ok("meta robots noindex", isNoindex(`<meta name="robots" content="noindex, follow">`, null));
  ok("googlebot noindex", isNoindex(`<meta content="NOINDEX" name="googlebot">`, null));
  ok("X-Robots-Tag noindex", isNoindex("", "noindex"));
  ok("index,follow is not", !isNoindex(`<meta name="robots" content="index,follow">`, "all"));
}

console.log("\nhomepage-only page rules");
{
  const html = "<html><head><title>x</title></head><body><h1>x</h1></body></html>";
  const nap = { name: "Acme", phone_number: "+15555550100" };
  const rootTypes = auditPage(html, nap).map((f) => f.finding_type);
  const subTypes = auditPage(html, nap, { isRoot: false }).map((f) => f.finding_type);
  ok("homepage still gets schema and phone rules", rootTypes.includes("missing_local_business_schema") && rootTypes.includes("phone_not_on_page"));
  ok("other pages don't", !subTypes.includes("missing_local_business_schema") && !subTypes.includes("phone_not_on_page"));
  ok("other rules still run on other pages", subTypes.includes("thin_content") && subTypes.includes("missing_meta_description"));
}

console.log("\nauditSite: links");
{
  const pages = [
    page("/", { internal_links: [`${S}/a`, `${S}/gone`, `${S}/moved`, `${S}/twice`, `${S}/beyond`], outbound_links: ["https://dead.example/x", "https://wall.example/y", "https://slow.example/z", "https://nodns.example/"] }),
    page("/a", { internal_links: [`${S}/`] }),
    page("/gone", { status_code: 404, in_sitemap: false }),
    page("/moved", { final_url: `${S}/a`, redirect_hops: 1, in_sitemap: false }),
    page("/twice", { final_url: `${S}/a`, redirect_hops: 2, in_sitemap: false }),
  ];
  const checks = [
    check(`${S}/beyond`, 500),
    check("https://dead.example/x", 404),
    check("https://wall.example/y", 403),
    check("https://slow.example/z", 0, { error: "timeout" }),
    check("https://nodns.example/", 0, { error: "dns" }),
  ];
  const fs = auditSite(site(pages, checks));
  const broken = of(fs, "broken_internal_links");
  ok("broken internal links: crawled 404 and checked 500", broken.length === 1 && (broken[0].details.count as number) === 2, broken);
  const redir = of(fs, "internal_links_redirect");
  ok("internal redirects found, warning when a hop chain is 2+", redir.length === 1 && redir[0].details.count === 2 && redir[0].severity === "warning", redir);
  const dead = of(fs, "broken_outbound_links");
  ok("outbound: 404 and DNS count; 403 and a timeout don't", dead.length === 1 && dead[0].details.count === 2, dead);
  const fromBroken = auditSite(site([page("/", { internal_links: [`${S}/x`] }), page("/x", { status_code: 404, internal_links: [`${S}/gone2`] })], [check(`${S}/gone2`, 404)]));
  ok("a page that didn't answer 200 isn't judged for its own links", !of(fromBroken, "broken_internal_links").some((f) => f.target_url.endsWith("/x")), of(fromBroken, "broken_internal_links"));
  ok("…while the page linking to it is", of(fromBroken, "broken_internal_links").some((f) => f.target_url === `${S}/`));
}

console.log("\nauditSite: duplicates");
{
  const pages = [
    page("/", { title: "Acme Plumbing", meta_description: "Same words here" }),
    page("/services/drains", { title: "acme  plumbing", meta_description: "Same words here" }),
    page("/about", { title: "Acme Plumbing" }),
    page("/print", { title: "Acme Plumbing", canonicals: [`${S}/about`] }), // deliberate duplicate
    page("/hidden", { title: "Acme Plumbing", noindex: true }),
    page("/blog/a-long-post", { title: "Unique" , meta_description: "Shared text" }),
    page("/blog", { title: "Blog", meta_description: "Shared text" }),
  ];
  const fs = auditSite(site(pages));
  const dupT = of(fs, "duplicate_title");
  ok("same title (ignoring case and spaces) on every page but the homepage", JSON.stringify(dupT.map((f) => f.target_url).sort()) === JSON.stringify([`${S}/about`, `${S}/services/drains`]), dupT.map((f) => f.target_url));
  ok("details carry the shared text and the other pages", dupT[0].details.title === "Acme Plumbing" && (dupT[0].details.also_on as string[]).length === 2, dupT[0].details);
  ok("canonicalised-away and noindex pages are left out", !dupT.some((f) => /print|hidden/.test(f.target_url)));
  const dupD = of(fs, "duplicate_meta_description");
  ok("description duplicates: the homepage keeps its text", dupD.some((f) => f.target_url === `${S}/services/drains`) && !dupD.some((f) => f.target_url === `${S}/`));
  ok("without the homepage, the shortest URL keeps it", dupD.some((f) => f.target_url === `${S}/blog/a-long-post`) && !dupD.some((f) => f.target_url === `${S}/blog`), dupD.map((f) => f.target_url));
}

console.log("\nauditSite: canonicals and sitemap");
{
  const pages = [
    page("/", { internal_links: [`${S}/a`, `${S}/b`, `${S}/c`, `${S}/d`, `${S}/e`] }),
    page("/a", { canonicals: [`${S}/a`, `${S}/z`] }),
    page("/b", { canonicals: ["https://other.com/b"] }),
    page("/c", { canonicals: [`${S}/old`] }),
    page("/d", { canonicals: [], noindex: true }),
    page("/e", { canonicals: [] }),
    page("/old", { status_code: 404 }),
    page("/r", { status_code: 200, redirect_hops: 1, final_url: `${S}/e` }),
  ];
  const fs = auditSite(site(pages));
  ok("two different canonicals", of(fs, "multiple_canonicals").length === 1 && of(fs, "multiple_canonicals")[0].target_url === `${S}/a`);
  ok("canonical on another site", of(fs, "canonical_other_site").length === 1);
  ok("canonical to a broken page", of(fs, "canonical_target_not_ok").length === 1 && of(fs, "canonical_target_not_ok")[0].target_url === `${S}/c`);
  ok("noindex page in the sitemap", of(fs, "noindex_in_sitemap").length === 1 && of(fs, "noindex_in_sitemap")[0].target_url === `${S}/d`);
  const sm = of(fs, "sitemap_url_not_ok").map((f) => f.target_url).sort();
  ok("sitemap lists a 404 and a redirect", JSON.stringify(sm) === JSON.stringify([`${S}/old`, `${S}/r`]), sm);
  const missing = of(fs, "pages_missing_canonical");
  ok("missing canonicals: one site-level note on the homepage, noindex excluded", missing.length === 1 && missing[0].target_url === `${S}/` && missing[0].details.count === 1, missing);
}

console.log("\nauditSite: orphans and limits");
{
  const pages = [
    page("/", { internal_links: [`${S}/a`, `${S}/moved`] }),
    page("/a", { internal_links: [`${S}/b`] }),
    page("/b", { internal_links: [`${S}/a`] }),
    page("/lonely"),
    page("/not-in-sitemap", { in_sitemap: false }),
    page("/via-redirect"),
    page("/moved", { final_url: `${S}/via-redirect`, redirect_hops: 1, in_sitemap: false }),
  ];
  const fs = auditSite(site(pages));
  const orphans = of(fs, "orphan_page").map((f) => f.target_url);
  ok("a sitemap page nothing links to is an orphan", orphans.includes(`${S}/lonely`), orphans);
  ok("a page reached through a redirect is not an orphan", !orphans.includes(`${S}/via-redirect`), orphans);
  ok("not in the sitemap → not reported as an orphan", !orphans.includes(`${S}/not-in-sitemap`));
  ok("homepage is never an orphan", !orphans.includes(`${S}/`));
  const weak = of(fs, "weakly_linked_pages");
  ok("weakly linked pages: one site-level note", weak.length === 1 && (weak[0].details.pages as string[]).includes(`${S}/b`), weak);
  ok("no limit note when the crawl finished", of(fs, "crawl_page_limit_reached").length === 0);

  const cut = auditSite(site(pages, [], { truncated: true, pageLimit: 7, sitemapUrlCount: 300 }));
  ok("truncated crawl: no orphan or weak-link claims", of(cut, "orphan_page").length === 0 && of(cut, "weakly_linked_pages").length === 0);
  const lim = of(cut, "crawl_page_limit_reached");
  ok("truncated crawl: says so, with the limit", lim.length === 1 && lim[0].details.page_limit === 7 && lim[0].details.sitemap_urls === 300, lim);
}

console.log("\nauditSite: a clean site");
{
  const pages = [page("/", { internal_links: [`${S}/a`] }), page("/a", { internal_links: [`${S}/`] })];
  const fs = auditSite(site(pages));
  ok("produces nothing but the weak-link note", JSON.stringify(types(fs)) === JSON.stringify(["weakly_linked_pages"]), types(fs));
  ok("empty input is fine", auditSite(site([])).length === 0);
}

console.log("\nportal: summarizeFindings / pagePath");
{
  const groups = summarizeFindings([
    { finding_type: "thin_content", severity: "warning", title: "t", target_url: `${S}/a` },
    { finding_type: "thin_content", severity: "warning", title: "t", target_url: `${S}/b` },
    { finding_type: "thin_content", severity: "warning", title: "t", target_url: `${S}/b` },
    { finding_type: "orphan_page", severity: "warning", title: "o", target_url: `${S}/c` },
    { finding_type: "crawl_fetch_failed", severity: "critical", title: "f", target_url: `${S}/` },
    { finding_type: "something_new", severity: "odd", title: "A new kind of issue", target_url: null },
  ]);
  ok("critical first, then most pages", groups.map((g) => g.type).join(",") === "crawl_fetch_failed,thin_content,orphan_page,something_new", groups.map((g) => g.type));
  ok("counts findings, lists each page once", groups[1].count === 3 && groups[1].pages.length === 2);
  ok("known types get a plain label", groups[1].label === "Pages with very little text");
  ok("unknown types fall back to the title, unknown severity to info", groups[3].label === "A new kind of issue" && groups[3].severity === "info");
  ok("pagePath", pagePath(`${S}/services/drains?x=1`) === "/services/drains?x=1" && pagePath("not a url") === "not a url");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

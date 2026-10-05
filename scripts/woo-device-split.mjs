#!/usr/bin/env node
// =============================================================================
// woo-device-split.mjs — what share of a WooCommerce store's buyers checked out
// on an iPhone vs an Android phone. Sizes the iMessage channel vs the Android
// channels in docs/zobi-competitive-plan.md §3.
//
//   WOO_CONSUMER_KEY=ck_… WOO_CONSUMER_SECRET=cs_… \
//     node scripts/woo-device-split.mjs https://budclubshop.com [days]
//
// `days` is optional (default 365) and limits the window to recent orders.
//
// HOW: WooCommerce stores the browser's user agent on every order
// (`customer_user_agent`, read-only in the v3 REST API). This script asks for
// ONLY that field plus id/status/customer_id — no names, emails, phones or
// addresses leave the store, and nothing personal is printed.
//
// WHAT IT CAN'T TELL YOU: a desktop buyer still owns a phone, and we don't know
// which kind. Orders created in wp-admin or by an integration have no user agent
// at all. So read the phone split as "of people who bought ON a phone". The
// exact answer per number comes later from the iMessage vendor's
// capability lookup, run against the consented contact list.
// =============================================================================

const RAW_BASE = process.argv[2];
const DAYS = Number(process.argv[3] ?? 365);
const KEY = process.env.WOO_CONSUMER_KEY;
const SECRET = process.env.WOO_CONSUMER_SECRET;

if (!RAW_BASE || !KEY || !SECRET || !Number.isFinite(DAYS) || DAYS <= 0) {
  console.error(
    "usage: WOO_CONSUMER_KEY=ck_… WOO_CONSUMER_SECRET=cs_… \\\n" +
      "  node scripts/woo-device-split.mjs https://store.example [days]",
  );
  process.exit(1);
}

let BASE = RAW_BASE.trim().replace(/\/+$/, "");
if (!/^https?:\/\//i.test(BASE)) BASE = `https://${BASE}`;

const auth = "Basic " + Buffer.from(`${KEY}:${SECRET}`).toString("base64");
const after = new Date(Date.now() - DAYS * 86_400_000).toISOString();

// Statuses that mean somebody actually paid. pending/failed/cancelled are
// abandoned or declined checkouts and would skew the split toward whoever
// retries the most.
const PAID = new Set(["processing", "completed", "on-hold", "refunded"]);

// Order matters: iPadOS and some Android tablets mention "Macintosh"/"Linux".
function classify(ua) {
  const s = String(ua ?? "");
  if (!s.trim()) return "no user agent (admin/API order)";
  if (/iPhone|iPod/i.test(s)) return "iPhone";
  if (/iPad/i.test(s)) return "iPad";
  if (/Android/i.test(s)) return /Mobile/i.test(s) ? "Android phone" : "Android tablet";
  if (/Macintosh|Mac OS X/i.test(s)) return "Mac desktop";
  if (/Windows/i.test(s)) return "Windows desktop";
  if (/CrOS|Linux/i.test(s)) return "Linux/ChromeOS desktop";
  return "other";
}

const counts = new Map();
const customerDevice = new Map(); // customer_id -> last seen device (registered accounts only)
let paidOrders = 0;
let scanned = 0;

for (let page = 1; ; page++) {
  const url =
    `${BASE}/wp-json/wc/v3/orders?per_page=100&page=${page}` +
    `&after=${encodeURIComponent(after)}&orderby=date&order=asc` +
    `&_fields=id,status,customer_id,customer_user_agent`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (res.status === 400) break; // asked past the last page
  if (!res.ok) {
    console.error(
      `HTTP ${res.status} from ${BASE}/wp-json/wc/v3/orders.\n` +
        `401/403 = the key lacks Read access or a security plugin blocks the REST API.`,
    );
    process.exit(1);
  }
  const batch = await res.json();
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const o of batch) {
    scanned++;
    if (!PAID.has(o.status)) continue;
    paidOrders++;
    const device = classify(o.customer_user_agent);
    counts.set(device, (counts.get(device) ?? 0) + 1);
    if (o.customer_id) customerDevice.set(o.customer_id, device);
  }
  const total = Number(res.headers.get("x-wp-totalpages"));
  if (Number.isInteger(total) && page >= total) break;
}

if (!paidOrders) {
  console.error(`Scanned ${scanned} orders in the last ${DAYS} days; none were paid.`);
  process.exit(2);
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);

console.log(`# ${BASE} — checkout device, last ${DAYS} days\n`);
console.log(`${paidOrders} paid orders (of ${scanned} scanned)\n`);
for (const [device, n] of rows) {
  console.log(`${device.padEnd(34)} ${String(n).padStart(7)}  ${pct(n, paidOrders)}`);
}

const iphone = counts.get("iPhone") ?? 0;
const android = counts.get("Android phone") ?? 0;
console.log(
  `\nPhone buyers only: iPhone ${pct(iphone, iphone + android)} · ` +
    `Android ${pct(android, iphone + android)}  (${iphone + android} orders)`,
);

if (customerDevice.size) {
  const byCustomer = new Map();
  for (const d of customerDevice.values()) byCustomer.set(d, (byCustomer.get(d) ?? 0) + 1);
  const ci = byCustomer.get("iPhone") ?? 0;
  const ca = byCustomer.get("Android phone") ?? 0;
  console.log(
    `Registered customers (${customerDevice.size}, by most recent order): ` +
      `iPhone ${pct(ci, ci + ca)} · Android ${pct(ca, ci + ca)} of phone buyers` +
      `\n(guest checkouts have no customer id and are only in the order counts above)`,
  );
}

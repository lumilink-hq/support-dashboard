# Outbound engine: account setup checklist

Phase 0 of [OUTBOUND-PLAN.md](OUTBOUND-PLAN.md), for whoever buys and sets up the accounts. It's about 3–4 hours of work in one sitting. Mailbox warm-up then takes 2–3 weeks, and that, not the build, sets the date of the first send, so **start as soon as possible**.

Budget, as approved: Instantly Growth $47/mo, Zapmail Starter $39/mo, 5 domains about $52/yr, Reoon about $29 once. That's **$86/mo and about $81 once**.

## 0. Before buying anything (about 15 min)

- [ ] **Vendor logins:** sign up for every account with a company email, such as a shared ops inbox, not a personal one. Save every login in the company password manager and turn on two-factor sign-in. Add a second person as an admin wherever the vendor allows it.
- [ ] **Payment:** use one company card for all of it, so renewals show up in one place.
- [ ] **Sender names:** pick the real people who will read and answer replies, for example two team members, one first and last name each. Real names keep the From line honest, which CAN-SPAM requires. Don't invent personas.
- [ ] **Postal address:** have the LumiLink address ready. CAN-SPAM requires a valid one in every email; a USPS PO box or a registered private mailbox is fine.
- [ ] **Profiles:** agree on the first two (audience × product), for example dispensaries × SEO and HVAC/plumbing × Phone Agent.
- [ ] **Caller:** name the person who calls every positive reply.

## 1. Domains on Cloudflare (about 30 min)

- [ ] **Availability:** check that all five are still free. All five were unregistered on 2026-10-08.
  - `getlumilink.com`
  - `trylumilink.com`
  - `uselumilink.com`
  - `lumilinkhq.com`
  - `hellolumilink.com`
- [ ] **Purchase:** buy all five in Cloudflare Registrar ($10.46/yr each, at cost) and turn on auto-renew.
- [ ] **Redirects:** point each domain at `https://www.lumilinkhub.com` with a permanent (301) Redirect Rule, so anyone who checks a sending domain lands on the real site. A redirect rule needs a proxied DNS record to exist; Cloudflare's redirect docs show the placeholder record to add.
- [ ] **Leave the email DNS alone.** Zapmail adds the email records in the next step.
- [ ] **Never use `lumilinkhub.com` or any subdomain of it for cold email.** Mail providers judge a subdomain by the main domain, and the main domain sends our client reports.

## 2. Mailboxes on Zapmail Starter (30–60 min)

- [ ] **Plan:** choose **Starter, the standard plan, not the pre-warmed plan.** Pre-warmed mailboxes come on generic domains Zapmail picks, not ours.
- [ ] **Connect the 5 domains.** If Zapmail asks for a Cloudflare API token, create one limited to *Edit DNS* on those five domains only.
- [ ] **Create 10 Google mailboxes, 2 per domain,** using the real sender names, for example `alex@getlumilink.com` and `jordan@getlumilink.com`.
- [ ] **Check the records on each domain** in Cloudflare's DNS tab:
  - **SPF** says which servers may send for the domain.
  - **DKIM** signs each email.
  - **DMARC** tells receivers what to do with mail that fails the other two. Set it to `p=none` to start, with reports going to an inbox someone reads.
  - **MX** is where replies are delivered.
- [ ] Add a profile photo and a short signature to each mailbox (optional, but it helps replies).

## 3. Instantly Growth (about 30 min)

- [ ] **Sign up:** subscribe to Growth ($47/mo).
- [ ] **Connect all 10 mailboxes** and **turn warm-up on** with Instantly's default ramp.
- [ ] **Record the warm-up start date** in OUTBOUND-PLAN.md, Phase 0. The first cold send is about 3 weeks after this date.
- [ ] **API key:** create one under **Settings → Integrations → API** and save it in the password manager. Instantly's help center says API access is on all Outbound plans. If no key can be created on Growth, move to Hypergrowth ($97/mo); the code doesn't change.
- [ ] **Campaigns:** create **two draft campaigns**, one per profile, and **leave them unstarted.** Settings for each:
  - Schedule: weekdays, business hours, in the recipient's time zone.
  - Plain text, with **open and click tracking off** (this helps emails land in the inbox).
  - Unsubscribe link **on**, and the postal address in the footer.
  - The email sequences come later (see step 6).
- [ ] **Campaign IDs:** note both, to give to engineering.

## 4. Reoon (about 10 min)

- [ ] **Account:** create one and buy the **25K credit pack** (about $29; the credits never expire).
- [ ] **API key:** create one and save it in the password manager.

## 5. Hand off to engineering

- [ ] **Set the keys as Supabase secrets yourself,** in the Supabase dashboard (Project Settings → Edge Functions → Secrets) or with the CLI. **Never paste a key into chat, email or a document.**
  - `INSTANTLY_API_KEY`
  - `REOON_API_KEY`
- [ ] **Send engineering** the two campaign IDs, the warm-up start date, and confirmation that both secrets are set.
- [ ] **Engineering then:**
  1. Pushes the migrations, after loyalty's, per [OUTBOUND-MIGRATIONS.md](OUTBOUND-MIGRATIONS.md).
  2. Deploys the functions and creates the Vault secrets.
  3. Runs the live tests in OUTBOUND-PLAN.md §8, including one real DataForSEO search (about $0.05), three Reoon checks, and an Instantly test campaign that only sends to our own inboxes.

## 6. While warm-up runs (weeks 1–3)

- [ ] **No cold email from any mailbox** until warm-up finishes.
- [ ] **Write the email sequences:** 2–3 short, plain-text emails per profile.
  - The first email has no links and no images.
  - No "free" and no spam-trigger words; run each one through a spam-word checker.
  - The only goal is a reply.
- [ ] **About week 2:** run a seed test on one domain (a deliverability tool sends test emails and reports inbox or spam). Check Instantly's warm-up health scores.
- [ ] **Week 3 onward:** start each mailbox at about **5 cold emails a day** and ramp to about **15**. Ten mailboxes come to roughly 150 a day.
- [ ] **Week 8:** review each profile's funnel and decide to keep, change or drop it.

// LL Loyalty embedded admin (0225, Phase 2 P4). Runs inside Shopify admin,
// served by app/embedded/route.ts. Plain JS + Polaris web components, no build.
//
// Every call goes to /api/loyalty/embedded with the App Bridge session token
// (shopify.idToken()). The server checks the token and the program; this file
// only renders what it gets back and posts what the merchant typed.
//
// Views (by URL hash): Program (setup, plan, earning and clocks, tiers,
// rewards, ways to earn), Members (filters, sort, 50 per page) and one member
// (stats, adjust points, tier, birthday, history, orders, codes).

(function () {
  "use strict";

  var root = document.getElementById("ll-app");
  var shop = root.getAttribute("data-shop") || "";
  var firstToken = new URLSearchParams(location.search).get("id_token");
  var state = null;

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(cents) {
    if (cents == null || cents === "") return "";
    var n = Number(cents) / 100;
    return n % 1 ? n.toFixed(2) : String(n);
  }
  function cents(v) {
    var s = String(v == null ? "" : v).replace(/[$,\s]/g, "");
    if (s === "") return "";
    var n = Number(s);
    return isFinite(n) ? String(Math.round(n * 100)) : "x";
  }
  function num(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  async function token() {
    if (window.shopify && typeof window.shopify.idToken === "function") return window.shopify.idToken();
    if (firstToken) return firstToken;
    throw new Error("Open LL Loyalty from Shopify admin.");
  }

  async function call(action, args) {
    var t = await token();
    var res = await fetch("/api/loyalty/embedded", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
      body: JSON.stringify({ action: action, args: args || {} }),
    });
    var j = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(errorText(j.error, res.status));
    return j;
  }

  function errorText(code, status) {
    if (code === "no_access") return "LL Loyalty isn't switched on for this store yet. Contact LumiLink.";
    if (status === 401) return "Your session ended. Reload the page.";
    if (code === "server_error" || !code) return "Something went wrong. Try again.";
    return code;
  }

  function toast(msg, isError) {
    if (window.shopify && window.shopify.toast) {
      window.shopify.toast.show(msg, { isError: !!isError });
      return;
    }
    var el = document.getElementById("ll-flash");
    if (el) el.innerHTML = '<s-banner tone="' + (isError ? "critical" : "success") + '">' + esc(msg) + "</s-banner>";
  }

  // Values from Polaris fields and plain inputs alike.
  function fields(form) {
    var out = {};
    form.querySelectorAll("[name]").forEach(function (el) {
      var name = el.getAttribute("name");
      if (el.tagName === "S-CHECKBOX" || el.type === "checkbox") out[name] = !!el.checked;
      else out[name] = el.value == null ? "" : String(el.value);
    });
    return out;
  }

  // ---------------------------------------------------------------- render
  function planSection(p) {
    if (!p) return "";
    var heading = "Plan: " + p.plan_name + (p.price_cents ? " · $" + money(p.price_cents) + "/month" : "");
    var over = p.over_cap
      ? p.overage_cents_per_100
        ? " Orders over the limit are $" + money(p.overage_cents_per_100) + " per 100."
        : " You're over the Free limit. Upgrade to keep growing (points keep working)."
      : "";
    var how = p.source === "shopify"
      ? "Change plan from LL Loyalty in Settings → Apps and sales channels."
      : "To change plan, contact LumiLink.";
    return '<s-section heading="' + esc(heading) + '">' +
      "<s-paragraph>" + esc(num(p.orders) + " of " + num(p.included_orders) + " orders included this month." + over) + "</s-paragraph>" +
      '<s-paragraph tone="subdued">' + esc(how) + "</s-paragraph></s-section>";
  }

  function setupSection(program) {
    var handle = shop.replace(/\.myshopify\.com$/, "");
    var editor = "https://admin.shopify.com/store/" + encodeURIComponent(handle) + "/themes/current/editor?context=apps";
    var backfill = program.backfill && program.backfill !== "done"
      ? '<s-banner tone="info">Reading your past orders so customers start in the right tier. No points are given for past orders.</s-banner>'
      : "";
    return '<s-section heading="Set up your store">' + backfill +
      "<s-paragraph>" + esc(num(program.members) + " members.") + " In the theme editor, turn on the <b>rewards launcher</b> app embed and add the <b>rewards page</b> block to a page.</s-paragraph>" +
      '<s-button href="' + esc(editor) + '" target="_top">Open the theme editor</s-button></s-section>';
  }

  function settingsSection(p) {
    var f = function (name, label, value, extra) {
      return '<s-number-field name="' + name + '" label="' + esc(label) + '" value="' + esc(value == null ? "" : value) + '" ' + (extra || "") + "></s-number-field>";
    };
    return '<s-section heading="Earning and clocks"><form data-action="save_settings"><div class="ll-grid">' +
      f("points_per_dollar", "Points per $1 spent", p.points_per_dollar, 'step="0.01" min="0.1" max="100"') +
      f("expire_months", "Points expire after (months without activity, empty = never)", p.expire_months, 'min="1" max="60"') +
      f("demote_months", "Down one tier after (months without an order)", p.demote_months, 'min="1" max="36"') +
      f("demotion_warning_days", "Demotion warning (days before)", p.demotion_warning_days, 'min="0" max="60"') +
      f("balance_reminder_days", "Balance reminder (every N days)", p.balance_reminder_days, 'min="7" max="365"') +
      f("near_tier_percent", "Near next tier within (%)", p.near_tier_percent, 'min="1" max="50"') +
      '</div><s-button type="submit" variant="primary">Save</s-button></form></s-section>';
  }

  function tiersSection(tiers) {
    var rows = tiers.map(function (t) {
      return '<div class="ll-row" data-tier="' + esc(t.key) + '">' +
        "<s-text>" + esc(t.name) + " · " + esc(num(t.members)) + " members</s-text>" +
        '<s-money-field name="min_spend_' + esc(t.key) + '" label="Spend to reach" value="' + esc(money(t.min_spend_cents)) + '"' + (t.rank === 0 ? " disabled" : "") + "></s-money-field>" +
        '<s-number-field name="multiplier_' + esc(t.key) + '" label="Points multiplier" step="0.05" min="1" max="5" value="' + esc(t.earn_multiplier) + '"></s-number-field>' +
        '<s-text-area name="perks_' + esc(t.key) + '" label="Perks shown to customers (one per line)" rows="2" value="' + esc((t.perks || []).join("\n")) + '"></s-text-area>' +
        "</div>";
    }).join("");
    return '<s-section heading="Tiers"><form data-action="save_tiers">' + rows +
      '<s-paragraph tone="subdued">Lowering a spend threshold moves qualifying members up straight away, without emails.</s-paragraph>' +
      '<s-button type="submit" variant="primary">Save tiers</s-button></form></s-section>';
  }

  function rewardForm(r) {
    var isNew = !r;
    r = r || { key: "", name: "", points_cost: "", value_cents: "", min_order_cents: 0, max_units: null, is_active: true, codes_issued: 0 };
    return '<form data-action="save_reward" data-key="' + esc(r.key) + '"><div class="ll-grid">' +
      '<s-text-field name="name" label="Name" value="' + esc(r.name) + '" placeholder="$5 off"></s-text-field>' +
      '<s-number-field name="points_cost" label="Points" min="1" value="' + esc(r.points_cost == null ? "" : r.points_cost) + '"' + (r.points_cost == null && !isNew ? " disabled" : "") + "></s-number-field>" +
      '<s-money-field name="value" label="Discount" value="' + esc(money(r.value_cents)) + '"></s-money-field>' +
      '<s-money-field name="min_order" label="Minimum order" value="' + esc(money(r.min_order_cents)) + '"></s-money-field>' +
      '<s-number-field name="max_units" label="Most at once (empty = no limit)" min="1" value="' + esc(r.max_units == null ? "" : r.max_units) + '"></s-number-field>' +
      "</div>" +
      '<s-checkbox name="is_active" label="Active"' + (r.is_active ? " checked" : "") + "></s-checkbox>" +
      (isNew ? "" : '<s-paragraph tone="subdued">' + esc(num(r.codes_issued) + " codes issued") + "</s-paragraph>") +
      '<s-button type="submit"' + (isNew ? ' variant="primary"' : "") + ">" + (isNew ? "Add reward" : "Save") + "</s-button></form>";
  }

  function rewardsSection(rewards) {
    return '<s-section heading="Rewards">' +
      rewards.map(function (r) { return '<s-box padding="base" border="base" border-radius="base">' + rewardForm(r) + "</s-box>"; }).join("") +
      '<s-heading>New reward</s-heading>' + rewardForm(null) + "</s-section>";
  }

  var RULE_LABEL = { signup: "Sign up", newsletter: "Newsletter sign-up", birthday: "Birthday", anniversary: "Member anniversary",
    instagram_follow: "Follow on Instagram", referral: "Refer a friend (referrer's points)" };
  function ruleLabel(r) {
    if (r.kind === "milestone") return "Order " + r.order_count + " milestone";
    return r.title || RULE_LABEL[r.key] || r.key.replace(/_/g, " ");
  }

  function rulesSection(rules) {
    return '<s-section heading="Ways to earn">' + rules.map(function (r) {
      return '<form data-action="save_earn_rule" data-key="' + esc(r.key) + '" class="ll-row">' +
        "<s-text>" + esc(ruleLabel(r)) + "</s-text>" +
        '<s-number-field name="points" label="Points" min="0" max="100000" value="' + esc(r.points) + '"></s-number-field>' +
        '<s-checkbox name="active" label="On"' + (r.is_active ? " checked" : "") + "></s-checkbox>" +
        '<s-button type="submit">Save</s-button></form>';
    }).join("") + "</s-section>";
  }

  // ---------------------------------------------------------------- members
  // Views by hash: "" program, #members (list, filters in memory), #member/<id>.
  var list = { filters: {}, sort: "points", dir: "desc", page: 1, data: null };
  var member = null;

  function date(v) {
    return v ? String(v).slice(0, 10) : "";
  }
  function fullName(m) {
    return [m.first_name, m.last_name].filter(Boolean).join(" ");
  }

  function nav(active) {
    var b = function (hash, label) {
      return '<s-button href="' + hash + '"' + (active === hash ? ' variant="primary"' : "") + ">" + label + "</s-button>";
    };
    return '<div class="ll-nav">' + b("#", "Program") + b("#members", "Members") + "</div>";
  }

  function membersView() {
    var f = list.filters;
    var tiers = (state.config.tiers || []).map(function (t) {
      return '<s-option value="' + esc(t.key) + '"' + (f.tier === t.key ? " selected" : "") + ">" + esc(t.name) + "</s-option>";
    }).join("");
    var flag = function (key, label) {
      return '<s-checkbox name="' + key + '" label="' + esc(label) + '"' + (f[key] ? " checked" : "") + "></s-checkbox>";
    };
    var sortOpt = function (v, label) {
      return '<s-option value="' + v + '"' + (list.sort === v ? " selected" : "") + ">" + label + "</s-option>";
    };
    var form = '<form data-action="members"><div class="ll-grid">' +
      '<s-search-field name="q" label="Search" placeholder="Email, name, customer ID or referral code" value="' + esc(f.q || "") + '"></s-search-field>' +
      // Polaris treats value="" as no value (select.value becomes the label), hence "all".
      '<s-select name="tier" label="Tier"><s-option value="all"' + (f.tier ? "" : " selected") + ">All tiers</s-option>" + tiers + "</s-select>" +
      '<s-select name="sort" label="Sort by">' + sortOpt("points", "Points") + sortOpt("spend", "Tier spend") + sortOpt("last_order", "Last order") + "</s-select>" +
      '<s-select name="dir" label="Order"><s-option value="desc"' + (list.dir === "desc" ? " selected" : "") + '>Highest / newest first</s-option><s-option value="asc"' + (list.dir === "asc" ? " selected" : "") + ">Lowest / oldest first</s-option></s-select>" +
      "</div>" + flag("can_redeem", "Can redeem a reward") + flag("demotes_30d", "Drops a tier within 30 days") + flag("expires_30d", "Points expire within 30 days") +
      '<s-button type="submit" variant="primary">Show members</s-button></form>';

    var d = list.data;
    var table = "";
    if (d) {
      var rows = (d.rows || []).map(function (r) {
        return "<tr>" +
          '<td><a href="#member/' + esc(r.id) + '">' + esc(fullName(r) || r.email || "(no name)") + "</a><div class=\"ll-sub\">" + esc(r.email || "") + "</div></td>" +
          "<td>" + esc(r.tier) + "</td><td class=\"ll-num\">" + esc(num(r.points)) + "</td>" +
          '<td class="ll-num">$' + esc(num(Math.round((r.tier_spend_cents || 0) / 100))) + '</td><td class="ll-num">' + esc(num(r.orders)) + "</td>" +
          "<td>" + esc(date(r.last_order_at)) + "</td></tr>";
      }).join("");
      var pages = Math.max(Math.ceil((d.total || 0) / (d.page_size || 50)), 1);
      table = (rows
        ? '<div class="ll-scroll"><table class="ll-table"><thead><tr><th>Member</th><th>Tier</th><th class="ll-num">Points</th><th class="ll-num">Tier spend</th><th class="ll-num">Orders</th><th>Last order</th></tr></thead><tbody>' + rows + "</tbody></table></div>"
        : "<s-paragraph>No members match.</s-paragraph>") +
        '<div class="ll-pager"><s-paragraph>' + esc(num(d.total) + (d.total === 1 ? " member" : " members") + " · page " + d.page + " of " + pages) + "</s-paragraph>" +
        (d.page > 1 ? '<s-button data-page="' + (d.page - 1) + '">Previous</s-button>' : "") +
        (d.page < pages ? '<s-button data-page="' + (d.page + 1) + '">Next</s-button>' : "") + "</div>";
    }
    return '<s-section heading="Members">' + form + table +
      '<s-paragraph tone="subdued">Every page of members you open is recorded in the access log.</s-paragraph></s-section>';
  }

  function memberView() {
    var d = member;
    if (!d) return "<s-section><s-spinner></s-spinner></s-section>";
    var m = d.member;
    var stat = function (label, value) {
      return '<div><div class="ll-sub">' + esc(label) + "</div><s-text>" + esc(value) + "</s-text></div>";
    };
    var tierOpts = (d.tiers || []).map(function (t) {
      return '<s-option value="' + esc(t.key) + '"' + (t.key === d.tier.key ? " selected" : "") + ">" + esc(t.name) + "</s-option>";
    }).join("");
    var ledger = (d.ledger || []).slice(0, 25).map(function (l) {
      return "<tr><td>" + esc(date(l.occurred_at)) + "</td><td>" + esc(l.reason + (l.rule_key ? " · " + l.rule_key : "")) + '</td><td class="ll-num">' +
        esc((l.points > 0 ? "+" : "") + num(l.points)) + '</td><td class="ll-num">' + esc(num(l.balance_after)) + "</td><td>" + esc(l.note || "") + "</td></tr>";
    }).join("");
    var orders = (d.orders || []).slice(0, 25).map(function (o) {
      return "<tr><td>" + esc(date(o.processed_at)) + "</td><td>" + esc(o.name || o.order_id) + '</td><td class="ll-num">$' + esc(money(o.eligible_cents)) +
        '</td><td class="ll-num">' + esc(num(o.points_earned - o.points_clawed)) + "</td></tr>";
    }).join("");
    var codes = (d.codes || []).map(function (c) {
      return "<tr><td>" + esc(c.code) + "</td><td>$" + esc(money(c.value_cents)) + "</td><td>" + esc(c.status) + "</td><td>" + esc(date(c.created_at)) + "</td></tr>";
    }).join("");
    var tbl = function (head, body) {
      return body ? '<div class="ll-scroll"><table class="ll-table"><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>" : "<s-paragraph>None yet.</s-paragraph>";
    };
    return '<s-section heading="' + esc(fullName(m) || m.email || "Member") + '">' +
      '<s-paragraph tone="subdued">' + esc((m.email || "") + " · customer " + m.shopify_customer_id + " · " + m.status) + "</s-paragraph>" +
      '<div class="ll-grid">' + stat("Points", num(m.points_balance)) + stat("Tier", d.tier.name) +
      stat("Tier spend", "$" + money(m.tier_spend_cents)) + stat("Orders", num(m.paid_order_count)) +
      stat("Member since", date(m.enrolled_at)) + stat("Last order", date(m.last_order_at) || "None") +
      stat("Birthday", m.birthday ? m.birthday.slice(5) : "Not set") + stat("Referral code", m.referral_code) + "</div></s-section>" +

      '<s-section heading="Adjust points"><form data-action="adjust" data-member="' + esc(m.id) + '"><div class="ll-grid">' +
      '<s-number-field name="points" label="Points (negative to remove)" step="1"></s-number-field>' +
      '<s-text-field name="note" label="Why (shown in the history)"></s-text-field></div>' +
      '<s-button type="submit" variant="primary">Adjust</s-button></form></s-section>' +

      '<s-section heading="Tier and birthday"><form data-action="set_tier" data-member="' + esc(m.id) + '"><div class="ll-grid">' +
      '<s-select name="tier" label="Tier">' + tierOpts + "</s-select>" +
      '<s-text-field name="note" label="Why"></s-text-field></div><s-button type="submit">Change tier</s-button></form>' +
      '<form data-action="set_birthday" data-member="' + esc(m.id) + '"><div class="ll-grid">' +
      '<s-date-field name="birthday" label="Birthday" value="' + esc(m.birthday || "") + '"></s-date-field>' +
      '<s-text-field name="note" label="Why"></s-text-field></div><s-button type="submit">Save birthday</s-button>' +
      '<s-paragraph tone="subdued">Leave the date empty to clear it, so the customer can set it again.</s-paragraph></form></s-section>' +

      '<s-section heading="Points history">' + tbl("<th>Date</th><th>What</th><th class=\"ll-num\">Points</th><th class=\"ll-num\">Balance</th><th>Note</th>", ledger) + "</s-section>" +
      '<s-section heading="Orders">' + tbl("<th>Date</th><th>Order</th><th class=\"ll-num\">Counted</th><th class=\"ll-num\">Points</th>", orders) + "</s-section>" +
      '<s-section heading="Reward codes">' + tbl("<th>Code</th><th>Value</th><th>Status</th><th>Created</th>", codes) + "</s-section>";
  }

  function render() {
    var d = state;
    var hash = location.hash || "#";
    var body;
    if (hash === "#members") body = nav("#members") + membersView();
    else if (hash.indexOf("#member/") === 0) body = nav("#members") + '<s-button href="#members" variant="tertiary">← All members</s-button>' + memberView();
    else body = nav("#") + setupSection(d.program) + planSection(d.plan) + settingsSection(d.config.program) +
      tiersSection(d.config.tiers) + rewardsSection(d.config.rewards) + rulesSection(d.config.earn_rules);
    root.innerHTML = '<s-page heading="' + esc(d.program.name) + '"><div id="ll-flash"></div>' + body + "</s-page>";
  }

  async function loadMembers() {
    var r = await call("members", { filters: list.filters, sort: list.sort, dir: list.dir, page: list.page });
    list.data = r.result;
  }

  async function route() {
    var hash = location.hash || "#";
    try {
      if (hash === "#members" && !list.data) {
        render();
        await loadMembers();
      } else if (hash.indexOf("#member/") === 0) {
        var id = hash.slice(8);
        if (!member || member.member.id !== id) {
          member = null;
          render();
          member = (await call("member", { member: id })).result;
        }
      }
      render();
    } catch (err) {
      render();
      toast(err.message, true);
    }
  }

  window.addEventListener("hashchange", route);

  root.addEventListener("click", async function (e) {
    var btn = e.target.closest("[data-page]");
    if (!btn) return;
    list.page = Number(btn.getAttribute("data-page")) || 1;
    try {
      await loadMembers();
      render();
      window.scrollTo(0, 0);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------------------------------------------------------------- save
  function requestKey() {
    return "emb-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function argsFor(form) {
    var v = fields(form);
    var action = form.getAttribute("data-action");
    var id = form.getAttribute("data-member");
    if (action === "save_settings") return { settings: v };
    if (action === "save_tiers") {
      return {
        tiers: state.config.tiers.map(function (t) {
          return {
            key: t.key,
            min_spend_cents: t.rank === 0 ? String(t.min_spend_cents) : cents(v["min_spend_" + t.key]),
            earn_multiplier: v["multiplier_" + t.key],
            perks: String(v["perks_" + t.key] || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
          };
        }),
      };
    }
    if (action === "save_reward") {
      return {
        reward: {
          key: form.getAttribute("data-key") || "",
          name: v.name, points_cost: v.points_cost, value_cents: cents(v.value), min_order_cents: cents(v.min_order),
          max_units: v.max_units, is_active: !!v.is_active,
        },
      };
    }
    if (action === "save_earn_rule") {
      return { key: form.getAttribute("data-key"), points: Number(v.points), active: !!v.active };
    }
    if (action === "adjust") return { member: id, points: Number(v.points), note: v.note, request_key: requestKey() };
    if (action === "set_tier") return { member: id, tier: v.tier, note: v.note };
    if (action === "set_birthday") return { member: id, birthday: v.birthday || null, note: v.note };
    return {};
  }

  var SAVED = {
    save_settings: "Settings saved", save_tiers: "Tiers saved", save_reward: "Reward saved", save_earn_rule: "Saved",
    adjust: "Points adjusted", set_tier: "Tier changed", set_birthday: "Birthday saved",
  };

  root.addEventListener("submit", async function (e) {
    var form = e.target.closest("form[data-action]");
    if (!form) return;
    e.preventDefault();
    var action = form.getAttribute("data-action");
    root.setAttribute("aria-busy", "true");
    try {
      if (action === "members") {
        var v = fields(form);
        list.filters = { q: String(v.q || "").trim(), tier: v.tier && v.tier !== "all" ? v.tier : "", can_redeem: !!v.can_redeem, demotes_30d: !!v.demotes_30d, expires_30d: !!v.expires_30d };
        if (list.filters.q.length === 1) throw new Error("Type at least 2 characters to search.");
        list.sort = v.sort || "points";
        list.dir = v.dir || "desc";
        list.page = 1;
        await loadMembers();
        render();
        return;
      }
      var r = await call(action, argsFor(form));
      if (r.member) {
        member = r.member;
        list.data = null; // balances changed: reload the list next time
        render();
        toast(action === "set_tier" && r.result === false ? "They're already on that tier" : SAVED[action]);
        return;
      }
      state = r;
      render();
      var promoted = action === "save_tiers" && state.result && state.result.promoted;
      toast(promoted ? SAVED[action] + ": " + promoted + " moved up a tier" : SAVED[action]);
    } catch (err) {
      toast(err.message, true);
    } finally {
      root.removeAttribute("aria-busy");
    }
  });

  (async function start() {
    root.innerHTML = '<s-page heading="LL Loyalty"><s-section><s-spinner accessibility-label="Loading"></s-spinner></s-section></s-page>';
    try {
      state = await call("load");
      await route();
    } catch (err) {
      root.innerHTML = '<s-page heading="LL Loyalty"><s-banner tone="critical">' + esc(err.message) + "</s-banner></s-page>";
    }
  })();
})();

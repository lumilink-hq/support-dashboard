// LL Loyalty embedded admin (0225, Phase 2 P4). Runs inside Shopify admin,
// served by app/embedded/route.ts. Plain JS + Polaris web components, no build.
//
// Every call goes to /api/loyalty/embedded with the App Bridge session token
// (shopify.idToken()). The server checks the token and the program; this file
// only renders what it gets back and posts what the merchant typed.
//
// Sections: overview (plan, setup), earning and clocks, tiers, rewards,
// earning rules. Members come next (plan P4).

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

  function render() {
    var d = state;
    root.innerHTML = '<s-page heading="' + esc(d.program.name) + '">' +
      '<div id="ll-flash"></div>' +
      setupSection(d.program) +
      planSection(d.plan) +
      settingsSection(d.config.program) +
      tiersSection(d.config.tiers) +
      rewardsSection(d.config.rewards) +
      rulesSection(d.config.earn_rules) +
      "</s-page>";
  }

  // ---------------------------------------------------------------- save
  function argsFor(form) {
    var v = fields(form);
    var action = form.getAttribute("data-action");
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
    return {};
  }

  var SAVED = { save_settings: "Settings saved", save_tiers: "Tiers saved", save_reward: "Reward saved", save_earn_rule: "Saved" };

  root.addEventListener("submit", async function (e) {
    var form = e.target.closest("form[data-action]");
    if (!form) return;
    e.preventDefault();
    var action = form.getAttribute("data-action");
    root.setAttribute("aria-busy", "true");
    try {
      state = await call(action, argsFor(form));
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
      render();
    } catch (err) {
      root.innerHTML = '<s-page heading="LL Loyalty"><s-banner tone="critical">' + esc(err.message) + "</s-banner></s-page>";
    }
  })();
})();

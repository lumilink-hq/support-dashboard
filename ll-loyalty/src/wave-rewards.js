/*
 * SOURCE. Edit this file, then `npm run build:blocks` (from ll-loyalty/) writes the
 * minified extensions/wave-rewards/assets/wave-rewards.js (app block JS must be < 10 KB).
 *
 * (src/wave-rewards-ref.js is built the same way into assets/wave-rewards-ref.js.)
 *
 * Wave Rewards page (LL Loyalty, module 5). Fills blocks/rewards-page.liquid
 * from the app proxy: GET {proxy}/state, POST {proxy}/redeem|birthday|claim|referral.
 * Program rules come from LumiLink; all copy comes from the extension's locale
 * file (snippets/llr-copy.liquid). Text is always set with textContent, never
 * innerHTML, so nothing from the server can inject markup.
 */
(function () {
  "use strict";

  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    [].slice.call(arguments, 2).forEach(function add(c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    });
    return el;
  }
  function C(x) { return { class: "llr-" + x }; }
  function n(x) { return Number(x).toLocaleString("en-US"); }
  function money(c) {
    var d = c / 100;
    return "$" + (d % 1 ? d.toLocaleString("en-US", { minimumFractionDigits: 2 }) : n(d));
  }
  function ordinal(x) {
    var s = ["th", "st", "nd", "rd"], v = x % 100;
    return x + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function rkey() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function has(list, x) { return (list || []).indexOf(x) > -1; }

  function Page(root) {
    var c = root.querySelector('[data-llr="copy"]');
    this.copy = c ? JSON.parse(c.textContent) : {};
    this.root = root;
    this.proxy = (root.dataset.proxy || "/apps/loyalty").replace(/\/+$/, "");
    this.ref = new URLSearchParams(location.search).get("ref");
  }
  var P = Page.prototype;

  P.t = function (k, vars) {
    return String(this.copy[k] || "").replace(/\{(\w+)\}/g, function (_, v) { return vars && vars[v] != null ? vars[v] : ""; });
  };
  P.part = function (name) { return this.root.querySelector('[data-llr="' + name + '"]'); };
  P.say = function (msg) { this.part("status").textContent = msg || ""; };
  P.fill = function (name) { var b = this.part(name); b.textContent = ""; for (var i = 1; i < arguments.length; i++) if (arguments[i]) b.appendChild(arguments[i]); };
  P.btn = function (label, onclick, cls) { return h("button", { type: "button", class: "llr-btn" + (cls ? " " + cls : ""), onclick: onclick }, label); };
  P.copyBtn = function (text) {
    var self = this, b = this.btn(this.t("copy"), function () {
      navigator.clipboard.writeText(text).then(function () {
        b.textContent = self.t("copied");
        setTimeout(function () { b.textContent = self.t("copy"); }, 1500);
      });
    }, "llr-btn--ghost");
    return b;
  };
  P.form = function (input, label, onsubmit) {
    var f = h("form", C("inline-form"), input, h("button", { type: "submit", class: "llr-btn" }, label));
    f.addEventListener("submit", function (e) { e.preventDefault(); onsubmit(f); });
    return f;
  };

  P.api = function (path, body) {
    var o = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body) { o.method = "POST"; o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(this.proxy + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._s = r.status; return j; });
    });
  };

  P.load = function () {
    var self = this;
    return this.api("/state").then(function (s) {
      if (s._s !== 200 || !s.program) throw 0;
      self.s = s;
      self.m = s.member;
      ["hero", "member", "referral", "earn", "tiers", "history"].forEach(function (x) { self[x](); });
    }).catch(function () {
      var l = self.part("loading");
      if (l) l.textContent = self.t("unavailable");
    });
  };

  P.find = function (list, key) { return (this.s[list] || []).filter(function (r) { return r.key === key; })[0]; };

  P.hero = function () {
    var m = this.m, r = this.root, hero = this.part("hero"), body = h("div", C("hero__body"));
    var l = this.part("loading");
    if (l) l.remove();
    var old = hero.querySelector(".llr-hero__body");
    if (old) old.remove();
    if (m) {
      body.appendChild(h("p", C("hero__hello"), m.first_name ? this.t("hi", { name: m.first_name }) : this.t("welcome_back")));
      body.appendChild(h("div", C("stats"),
        h("div", C("stat"), h("span", C("stat__value"), n(m.points)), h("span", C("stat__label"), this.t("points"))),
        h("div", C("stat"), h("span", C("stat__value"), m.tier.name), h("span", C("stat__label"), this.t("tier")))));
      var nt = m.next_tier;
      if (nt) {
        var pct = Math.max(0, Math.min(100, Math.round((m.tier_spend_cents / nt.min_spend_cents) * 100)));
        body.appendChild(h("div", { class: "llr-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct },
          h("div", { class: "llr-progress__bar", style: "width:" + pct + "%" })));
      }
      body.appendChild(h("p", C("muted"), nt ? this.t("spend_more", { amount: money(nt.remaining_cents), tier: nt.name }) : this.t("top_tier")));
    } else if (this.s.logged_in) {
      body.appendChild(h("p", null, this.t("setting_up")));
    } else {
      body.appendChild(h("div", C("actions"),
        h("a", { class: "llr-btn", href: r.dataset.loginUrl }, this.t("sign_in")),
        h("a", { class: "llr-btn llr-btn--light", href: r.dataset.registerUrl }, this.t("sign_up"))));
    }
    hero.appendChild(body);
  };

  P.member = function () {
    var self = this, m = this.m;
    if (!m) return this.fill("member");
    var cards = (this.s.rewards || []).filter(function (r) { return r.points_cost; }).map(function (r) {
      var short = r.points_cost - m.points, armed = 0;
      var b = self.btn(self.t("redeem"), function () {
        if (!armed++) return (b.textContent = self.t("confirm_spend", { points: n(r.points_cost) }));
        b.disabled = true;
        b.textContent = self.t("redeeming");
        self.redeem(r, b);
      });
      b.disabled = short > 0;
      return h("div", C("card"), h("h3", null, r.name),
        h("p", C("muted"), self.t("points_cost", { points: n(r.points_cost) })),
        short > 0 && h("p", C("muted"), self.t("points_to_go", { points: n(short) })), b);
    });
    var codes = (m.codes || []).map(function (c) {
      return h("li", null, h("span", C("code"), c.code),
        h("span", C("muted"), " " + self.t("amount_off", { amount: money(c.value_cents) }) + (c.status === "pending" ? " · " + self.t("being_created") : "")),
        c.status === "issued" && self.copyBtn(c.code));
    });
    this.fill("member", h("section", C("rewards"),
      h("h2", C("heading"), this.t("your_rewards")), h("div", C("grid"), cards),
      codes.length && [h("h3", null, this.t("your_codes")), h("ul", C("codes"), codes), h("p", C("muted"), this.t("codes_note"))]));
  };

  P.redeem = function (r, b) {
    var self = this, reset = function (k) { b.disabled = false; b.textContent = self.t("redeem"); self.say(self.t(k)); };
    this.api("/redeem", { reward_key: r.key, request_key: rkey() }).then(function (x) {
      if (x.status !== "redeemed") return reset(x.status === "insufficient_points" ? "not_enough" : "failed");
      self.say(self.t(x.code_status === "issued" ? "code_ready" : "code_pending", { code: x.code }));
      self.load();
    }, function () { reset("failed"); });
  };

  P.referral = function () {
    var self = this, m = this.m, friend = this.find("rewards", "referral_friend"), rule = this.find("earn_rules", "referral");
    if (!friend) return this.fill("referral");
    // A friend arriving on a referral link (not the referrer): the form is
    // lazy-loaded (wave-rewards-ref.js) so everyone else skips its bytes.
    if (this.ref && !(m && m.referral_code === this.ref.toUpperCase())) {
      var go = function () { window.LLR_REF(self, h, money, friend); };
      if (window.LLR_REF) return go();
      var sc = h("script", { src: this.root.dataset.refJs, async: true });
      sc.onload = go;
      return document.head.appendChild(sc);
    }
    if (!m || !rule) return this.fill("referral");
    var link = location.origin + location.pathname + "?ref=" + encodeURIComponent(m.referral_code);
    this.fill("referral", h("section", C("referral"), h("h2", C("heading"), this.t("refer_title")),
      h("p", null, this.t("refer_text", { amount: money(friend.value_cents), points: rule.points })),
      h("div", C("inline-form"), h("input", { type: "text", readonly: true, value: link, "aria-label": this.t("your_link") }), this.copyBtn(link))));
  };

  P.card = function (key, title, desc, extra) {
    return h("div", { class: "llr-card llr-card--earn", "data-rule": key }, h("span", { class: "llr-icon", "aria-hidden": "true" }), h("h3", null, title), h("p", null, desc), extra);
  };

  P.earn = function () {
    var self = this, m = this.m, box = this.part("earn"), done = m ? m.claimed : [], ms = [];
    var cards = [this.card("order", this.t("order_title"),
      this.t("order_text", { points: this.s.program.points_per_dollar }) + (m && m.tier.multiplier > 1 ? this.t("at_tier", { mult: m.tier.multiplier }) : ""))];
    (this.s.earn_rules || []).forEach(function (r) {
      if (r.kind === "milestone") return ms.push(r);
      cards.push(self.card(r.key, r.title || self.t("rule_" + r.key + "_title") || r.key.replace(/_/g, " "),
        r.description ? r.description.replace("{points}", r.points) : self.t("rule_" + r.key + "_text", r) || self.t("rule_other_text", r),
        self.action(r, done)));
    });
    if (ms.length) {
      cards.push(this.card("milestone", this.t("milestones_title"), m ? this.t("milestones_member", { count: m.paid_order_count }) : this.t("milestones_guest"),
        h("ul", C("list"), ms.map(function (r) {
          return h("li", null, self.t("milestone_line", { nth: ordinal(r.order_count), points: r.points }) + (has(done, r.key) ? " ✓" : ""));
        }))));
    }
    this.fill("earn", h("section", C("earn"), h("h2", C("heading"), box.dataset.heading),
      h("p", C("sub"), box.dataset.subheading), h("div", C("grid"), cards)));
  };

  P.action = function (r, done) {
    var self = this, m = this.m;
    if (!m) return null;
    if (r.key === "birthday") {
      if (m.birthday) {
        return h("p", C("done"), this.t("birthday_yours", {
          date: new Date(m.birthday + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" }) }));
      }
      var input = h("input", { type: "date", required: true, max: new Date().toISOString().slice(0, 10), "aria-label": this.t("your_birthday") });
      return h("div", null, this.form(input, this.t("save"), function () {
        self.api("/birthday", { birthday: input.value }).then(function (x) {
          self.say(self.t(x.status === "set" ? "birthday_saved" : x.status === "already_set" ? "birthday_already" : "invalid_date"));
          if (x.status === "set") self.load();
        });
      }), h("p", C("muted"), this.t("once_note")));
    }
    if (has(done, r.key)) return h("p", C("done"), this.t("done"));
    if (!r.claimable) return null;
    var ig = r.key === "instagram_follow", url = this.root.dataset.instagramUrl;
    var b = this.btn(this.t(ig ? "follow_earn" : "claim"), function () {
      if (ig && url) window.open(url, "_blank", "noopener");
      b.disabled = true;
      self.api("/claim", { key: r.key }).then(function (x) {
        self.say(x.status === "claimed" ? self.t("claimed", { points: x.points }) : self.t("already_claimed"));
        self.load();
      }, function () { b.disabled = false; });
    });
    return b;
  };

  P.tiers = function () {
    var self = this, m = this.m, box = this.part("tiers");
    var cards = (this.s.tiers || []).map(function (t) {
      var cur = m && m.tier.key === t.key, perks = Array.isArray(t.perks) ? t.perks : [];
      return h("div", { class: "llr-tier" + (cur ? " llr-tier--current" : "") },
        cur && h("span", C("badge"), self.t("your_tier")), h("h3", null, t.name),
        h("p", C("tier__unlock"), t.min_spend_cents > 0 ? self.t("spend_unlock", { amount: money(t.min_spend_cents) }) : self.t("welcome_tier")),
        perks.length && h("ul", C("list"), perks.map(function (p) { return h("li", null, p); })));
    });
    this.fill("tiers", h("section", C("tiers"), h("h2", C("heading"), box.dataset.heading),
      h("p", C("sub"), box.dataset.subheading), h("div", C("grid"), cards)));
  };

  P.history = function () {
    var self = this, m = this.m;
    if (!m || !m.history || !m.history.length) return this.fill("history");
    var th = function (k) { return h("th", null, self.t(k)); };
    this.fill("history", h("section", C("history"), h("h2", C("heading"), this.t("recent_activity")),
      h("table", null, h("thead", null, h("tr", null, th("col_date"), th("col_activity"), th("col_points"))),
        h("tbody", null, m.history.map(function (e) {
          return h("tr", null,
            h("td", null, new Date(e.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })),
            h("td", null, (e.rule_key && self.t("rule_" + e.rule_key + "_title")) || self.t("reason_" + e.reason) || e.reason),
            h("td", { class: e.points > 0 ? "llr-plus" : "llr-minus" }, (e.points > 0 ? "+" : "") + n(e.points)));
        })))));
  };

  function boot() {
    document.querySelectorAll(".llr").forEach(function (root) {
      if (root.dataset.llrReady) return;
      root.dataset.llrReady = "1";
      new Page(root).load();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  document.addEventListener("shopify:section:load", boot); // theme editor
})();

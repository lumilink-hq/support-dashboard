/*
 * SOURCE. Edit this file, then `npm run build:blocks` (from ll-loyalty/) writes the
 * minified extensions/wave-rewards/assets/wave-rewards.js (app block JS must be < 10 KB).
 * Lazy chunks, built the same way: src/wave-rewards-member.js (signed-in
 * member views, loaded only for members) and src/wave-rewards-ref.js (the
 * referred friend's form, only on ?ref= visits).
 *
 * Wave Rewards page (LL Loyalty, module 5). Fills blocks/rewards-page.liquid
 * from the app proxy: GET {proxy}/state, POST {proxy}/redeem|birthday|claim|referral.
 * Program rules come from LumiLink; all copy comes from the extension's locale
 * file (snippets/llr-copy.liquid).
 *
 * Markup is built with H`…`, a tagged template that HTML-escapes every
 * interpolated value unless it is itself an H`…` result. Never build markup
 * any other way. Clicks and submits go through one delegated handler
 * (data-act / data-form) so the bundle stays small.
 */
(function () {
  "use strict";

  function R(s) { this.s = s; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function out(v) { return v == null || v === false ? "" : v instanceof R ? v.s : Array.isArray(v) ? v.map(out).join("") : esc(v); }
  function H(t) {
    var s = t[0];
    for (var i = 1; i < t.length; i++) s += out(arguments[i]) + t[i];
    return new R(s);
  }
  function n(x) { return Number(x).toLocaleString("en-US"); }
  function money(c) { var d = c / 100; return "$" + (d % 1 ? d.toLocaleString("en-US", { minimumFractionDigits: 2 }) : n(d)); }
  function pct(a, b) { return b > 0 ? Math.max(0, Math.min(100, Math.round((a / b) * 100))) : 100; }
  function ordinal(x) { var s = ["th", "st", "nd", "rd"], v = x % 100; return x + (s[(v - 20) % 10] || s[v] || s[0]); }
  function rkey() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
  function has(l, x) { return (l || []).indexOf(x) > -1; }
  function day(iso, o) { return new Date(iso).toLocaleDateString("en-US", o || { month: "short", day: "numeric", year: "numeric" }); }

  var U = { H: H, R: R, n: n, money: money, pct: pct, rkey: rkey, day: day };

  function Page(root) {
    var c = root.querySelector('[data-llr="copy"]'), d = document.createElement("textarea"), k;
    this.copy = c ? JSON.parse(c.textContent) : {};
    // Shopify's `t` filter HTML-escapes copy ("you&#39;re"); decode it once here.
    // H`…` escapes again when it renders, so this is display-only.
    for (k in this.copy) { d.innerHTML = this.copy[k]; this.copy[k] = d.value; }
    this.root = root;
    this.app = root.querySelector('[data-llr="app"]');
    this.proxy = (root.dataset.proxy || "/apps/loyalty").replace(/\/+$/, "");
    this.ref = new URLSearchParams(location.search).get("ref");
    root.addEventListener("click", this.click.bind(this));
    root.addEventListener("submit", this.submit.bind(this));
  }
  var P = Page.prototype;

  P.t = function (k, v) {
    return String(this.copy[k] || "").replace(/\{(\w+)\}/g, function (_, x) { return v && v[x] != null ? v[x] : ""; });
  };
  P.say = function (msg) {
    var s = this.root.querySelector('[data-llr="status"]');
    s.textContent = msg || "";
    clearTimeout(this.sayT);
    this.sayT = setTimeout(function () { s.textContent = ""; }, 6000);
  };
  P.api = function (path, body) {
    var o = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body) { o.method = "POST"; o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(this.proxy + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j._s = r.status; return j; });
    });
  };
  P.find = function (list, key) { return (this.s[list] || []).filter(function (r) { return r.key === key; })[0]; };

  P.load = function () {
    var self = this;
    return this.api("/state").then(function (s) {
      if (s._s !== 200 || !s.program) throw 0;
      self.s = s;
      self.m = s.member;
      return s.member ? self.script("LLR_MEMBER", "memberJs") : null;
    }).then(function () {
      if (self.m) window.LLR_MEMBER(P, U);
      self.app.innerHTML = self.view().s;
      self.friend();
    }).catch(function () {
      self.app.innerHTML = H`<p class="llr-empty">${self.t("unavailable")}</p>`.s;
    });
  };

  P.view = function () {
    var m = this.m;
    return H`${m ? this.card() : this.hero()}<div data-llr="friend"></div>${m ? this.rewards() : this.how()}${this.earn()}${m ? this.refer() : ""}${this.tiers()}${m ? this.history() : ""}`;
  };

  // Cheapest reward the member can buy with points, for the card's "next reward" line.
  P.next = function () {
    return (this.s.rewards || []).filter(function (r) { return r.points_cost; }).sort(function (a, b) { return a.points_cost - b.points_cost; })[0];
  };

  P.hero = function () {
    var r = this.root.dataset, s = this.s, top = (s.tiers || [])[s.tiers.length - 1], nx = this.next();
    return H`<section class="llr-hero"><div class="llr-wrap">
      <h2 class="llr-hero__title">${r.heroTitle}</h2><p class="llr-hero__sub">${r.heroSubtitle}</p>
      ${s.logged_in ? H`<p class="llr-hero__sub">${this.t("setting_up")}</p>` : H`<div class="llr-actions">
        <a class="llr-btn" href="${r.registerUrl}">${this.t("join_cta")}</a><a class="llr-btn llr-btn--ghost" href="${r.loginUrl}">${this.t("sign_in")}</a></div>`}
      <ul class="llr-chips"><li>${this.t("chip_earn", { points: s.program.points_per_dollar })}</li>
        ${nx ? H`<li>${this.t("chip_redeem", { points: n(nx.points_cost), reward: nx.name })}</li>` : ""}
        ${top && top.multiplier > 1 ? H`<li>${this.t("chip_tier", { mult: top.multiplier, tier: top.name })}</li>` : ""}</ul>
    </div></section>`;
  };

  P.how = function () {
    var tpl = this.root.querySelector('[data-llr="how"]');
    return tpl ? new R(tpl.innerHTML) : "";
  };

  P.tile = function (key, title, desc, pts, extra, done) {
    return H`<div class="llr-tile${done ? " llr-tile--done" : ""}" data-rule="${key}"><span class="llr-ico" aria-hidden="true"></span>
      <div class="llr-tile__body"><div class="llr-tile__head"><h3>${title}</h3>${pts ? H`<span class="llr-pill">${pts}</span>` : ""}</div>
      <p>${desc}</p>${extra}</div></div>`;
  };

  P.earn = function () {
    var self = this, m = this.m, done = m ? m.claimed : [], ms = [], box = this.root.dataset, tiles = [];
    tiles.push(this.tile("order", this.t("order_title"),
      this.t("order_text", { points: this.s.program.points_per_dollar }) + (m && m.tier.multiplier > 1 ? this.t("at_tier", { mult: m.tier.multiplier }) : ""),
      this.s.program.points_per_dollar + " " + this.t("per_dollar")));
    (this.s.earn_rules || []).forEach(function (r) {
      if (r.kind === "milestone") return ms.push(r);
      var d = has(done, r.key);
      tiles.push(self.tile(r.key, r.title || self.t("rule_" + r.key + "_title") || r.key.replace(/_/g, " "),
        r.description ? r.description.replace("{points}", r.points) : self.t("rule_" + r.key + "_text", r) || self.t("rule_other_text", r),
        "+" + n(r.points), self.action(r, d), d));
    });
    if (ms.length) {
      tiles.push(this.tile("milestone", this.t("milestones_title"), m ? this.t("orders_count", { count: m.paid_order_count }) : this.t("milestones_guest"), "",
        H`<ul class="llr-steps">${ms.map(function (r) {
          return H`<li class="${has(done, r.key) ? "is-done" : ""}"><span>${ordinal(r.order_count)}</span><b>+${n(r.points)}</b></li>`;
        })}</ul>`));
    }
    return H`<section class="llr-sec llr-sec--band"><div class="llr-wrap"><h2 class="llr-h">${box.earnHeading}</h2>
      <p class="llr-sub">${box.earnSubheading}</p><div class="llr-grid">${tiles}</div></div></section>`;
  };

  P.action = function (r, done) {
    var m = this.m;
    if (!m) return "";
    if (r.key === "birthday") {
      if (m.birthday) return H`<p class="llr-done">${this.t("birthday_yours", { date: day(m.birthday + "T12:00:00", { month: "long", day: "numeric" }) })}</p>`;
      return H`<form class="llr-inline" data-form="birthday"><input type="date" name="birthday" required max="${new Date().toISOString().slice(0, 10)}" aria-label="${this.t("your_birthday")}">
        <button type="submit" class="llr-btn llr-btn--sm">${this.t("save")}</button></form><p class="llr-muted">${this.t("once_note")}</p>`;
    }
    if (done) return H`<p class="llr-done">${this.t("done")}</p>`;
    if (!r.claimable) return "";
    return H`<button type="button" class="llr-btn llr-btn--sm" data-act="claim" data-key="${r.key}">${this.t(r.key === "instagram_follow" ? "follow_earn" : "claim")}</button>`;
  };

  P.tiers = function () {
    var self = this, m = this.m, box = this.root.dataset, cur = -1, ts = this.s.tiers || [];
    ts.forEach(function (t, i) { if (m && m.tier.key === t.key) cur = i; });
    // The current tier's track segment fills by progress toward the next tier.
    var seg = cur > -1 && ts[cur + 1] ? pct(m.tier_spend_cents - ts[cur].min_spend_cents, ts[cur + 1].min_spend_cents - ts[cur].min_spend_cents) : 0;
    return H`<section class="llr-sec"><div class="llr-wrap"><h2 class="llr-h">${box.tiersHeading}</h2><p class="llr-sub">${box.tiersSubheading}</p>
      <ol class="llr-ladder">${ts.map(function (t, i) {
        var perks = Array.isArray(t.perks) ? t.perks : [];
        return H`<li class="llr-step${i < cur ? " is-reached" : ""}${i === cur ? " is-current" : ""}"${i === cur ? H` style="--p:${seg}%"` : ""}><span class="llr-step__dot"></span>
          <div class="llr-step__card"><div class="llr-step__head"><h3>${t.name}</h3>${i === cur ? H`<span class="llr-pill llr-pill--on">${self.t("you_are_here")}</span>` : ""}</div>
          <p class="llr-step__unlock">${t.min_spend_cents > 0 ? self.t("spend_unlock", { amount: money(t.min_spend_cents) }) : self.t("welcome_tier")}</p>
          ${perks.length ? H`<ul>${perks.map(function (p) { return H`<li>${p}</li>`; })}</ul>` : ""}</div></li>`;
      })}</ol></div></section>`;
  };

  // Load a lazy chunk once (window[name] set by it); resolves when ready.
  P.script = function (name, attr) {
    var src = this.root.dataset[attr];
    return window[name] ? Promise.resolve() : new Promise(function (ok, no) {
      var sc = document.createElement("script");
      sc.src = src;
      sc.onload = ok;
      sc.onerror = no;
      document.head.appendChild(sc);
    });
  };

  // A friend arriving on a referral link (not the referrer): lazy-loaded form.
  P.friend = function () {
    var self = this, f = this.find("rewards", "referral_friend"), m = this.m;
    if (!this.ref || !f || (m && m.referral_code === this.ref.toUpperCase())) return;
    this.script("LLR_REF", "refJs").then(function () { window.LLR_REF(self, H, money, f); });
  };

  P.click = function (e) {
    var b = e.target.closest("[data-act]"), self = this;
    if (!b || b.disabled) return;
    var a = b.dataset.act;
    if (a === "copy") {
      navigator.clipboard.writeText(b.dataset.text).then(function () {
        var t = b.textContent;
        b.textContent = self.t("copied");
        setTimeout(function () { b.textContent = t; }, 1500);
      });
    } else if (a === "redeem") {
      this.redeem(b);
    } else if (a === "claim") {
      var url = this.root.dataset.instagramUrl;
      if (b.dataset.key === "instagram_follow" && url) window.open(url, "_blank", "noopener");
      b.disabled = true;
      this.api("/claim", { key: b.dataset.key }).then(function (x) {
        self.say(x.status === "claimed" ? self.t("claimed", { points: x.points }) : self.t("already_claimed"));
        self.load();
      }, function () { b.disabled = false; });
    }
  };

  P.submit = function (e) {
    var f = e.target, self = this;
    if (f.dataset.form !== "birthday") return;
    e.preventDefault();
    this.api("/birthday", { birthday: f.birthday.value }).then(function (x) {
      self.say(self.t(x.status === "set" ? "birthday_saved" : x.status === "already_set" ? "birthday_already" : "invalid_date"));
      if (x.status === "set") self.load();
    });
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

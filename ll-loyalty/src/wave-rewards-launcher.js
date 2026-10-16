/*
 * SOURCE for assets/wave-rewards-launcher.js (`npm run build:blocks`).
 *
 * Wave Rewards launcher (LL Loyalty): the floating button + panel from
 * blocks/launcher.liquid, on every page. Nothing is fetched until the shopper
 * opens the panel; then GET {proxy}/state (same response the rewards page uses)
 * and POST {proxy}/redeem. Copy comes from the embed's JSON (locale file).
 *
 * Markup only through H`…`, which HTML-escapes every interpolated value unless
 * it is itself an H`…` result (same rule as wave-rewards.js).
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
  function rkey() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }

  function L(root) {
    var c = root.querySelector('[data-llrl="copy"]'), d = document.createElement("textarea"), k;
    this.copy = c ? JSON.parse(c.textContent) : {};
    for (k in this.copy) { d.innerHTML = this.copy[k]; this.copy[k] = d.value; } // undo the `t` filter's escaping
    this.root = root;
    this.ds = root.dataset;
    this.btn = root.querySelector('[data-llrl="toggle"]');
    this.panel = root.querySelector('[data-llrl="panel"]');
    this.body = root.querySelector('[data-llrl="body"]');
    this.proxy = (this.ds.proxy || "/apps/loyalty").replace(/\/+$/, "");
    if (this.ds.points) this.label(this.ds.points);
    this.btn.addEventListener("click", this.toggle.bind(this));
    root.addEventListener("click", this.click.bind(this));
    this.onKey = this.onKey.bind(this);
    this.onDoc = this.onDoc.bind(this);
    root.hidden = false;
  }
  var P = L.prototype;

  P.t = function (k, v) {
    return String(this.copy[k] || "").replace(/\{(\w+)\}/g, function (_, x) { return v && v[x] != null ? v[x] : ""; });
  };
  P.label = function (p) { this.root.querySelector('[data-llrl="label"]').textContent = this.t("ln_pts", { points: n(p) }); };
  P.say = function (msg) {
    var s = this.root.querySelector('[data-llrl="status"]');
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

  P.toggle = function () { this.panel.hidden ? this.open() : this.close(); };
  P.open = function () {
    this.panel.hidden = false;
    this.btn.setAttribute("aria-expanded", "true");
    document.addEventListener("keydown", this.onKey);
    document.addEventListener("click", this.onDoc, true);
    this.root.querySelector('[data-llrl="close"]').focus();
    if (!this.s) this.load();
  };
  P.close = function () {
    this.panel.hidden = true;
    this.btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("keydown", this.onKey);
    document.removeEventListener("click", this.onDoc, true);
  };
  P.onKey = function (e) { if (e.key === "Escape") { this.close(); this.btn.focus(); } };
  P.onDoc = function (e) { if (!this.root.contains(e.target)) this.close(); };

  P.load = function () {
    var self = this;
    if (!this.s) this.body.innerHTML = H`<p class="llrl-muted">${this.t("loading")}</p>`.s;
    return this.api("/state").then(function (s) {
      if (s._s !== 200 || !s.program) throw 0;
      self.s = s;
      self.m = s.member;
      if (self.m) self.label(self.m.points);
      self.body.innerHTML = (self.m ? self.member() : self.guest()).s;
    }).catch(function () {
      self.body.innerHTML = H`<p class="llrl-muted">${self.t("unavailable")}</p>`.s;
    });
  };

  // Cheapest reward bought with points: the "next reward" line.
  P.next = function () {
    return (this.s.rewards || []).filter(function (r) { return r.points_cost; }).sort(function (a, b) { return a.points_cost - b.points_cost; })[0];
  };
  P.find = function (list, key) { return (this.s[list] || []).filter(function (r) { return r.key === key; })[0]; };
  // Dynamic rewards (0218: max_units, null = no cap): a picker when the member
  // can afford 2+ in one code; at most 50 options.
  P.units = function (r) {
    var self = this, can = Math.floor(this.m.points / r.points_cost), o = [];
    var k = Math.min(r.max_units == null ? can : r.max_units, can, 50);
    if (k < 2) return "";
    for (var i = 1; i <= k; i++) o.push(H`<option value="${i}">${self.t("units_option", { amount: money(r.value_cents * i), points: n(r.points_cost * i) })}</option>`);
    return H`<label class="llrl-units"><span>${this.t("units_label")}</span><select name="units">${o}</select></label>`;
  };
  P.all = function () { return H`<a class="llrl-all" href="${this.ds.page}">${this.t("ln_see_all")} &rarr;</a>`; };

  P.guest = function () {
    var self = this, ds = this.ds, s = this.s;
    var ways = [H`<li><span>${this.t("order_title")}</span><b>${this.t("chip_earn", { points: s.program.points_per_dollar })}</b></li>`];
    (s.earn_rules || []).forEach(function (r) {
      if (r.kind === "milestone") return;
      ways.push(H`<li><span>${r.title || self.t("rule_" + r.key + "_title") || r.key.replace(/_/g, " ")}</span><b>+${n(r.points)}</b></li>`);
    });
    var rewards = (s.rewards || []).filter(function (r) { return r.points_cost; }).map(function (r) {
      return H`<li><span>${r.name}</span><b>${self.t("points_cost", { points: n(r.points_cost) })}</b></li>`;
    });
    return H`${s.logged_in ? H`<p class="llrl-muted">${this.t("setting_up")}</p>` : H`<div class="llrl-cta">
        <a class="llrl-b" href="${ds.registerUrl}">${this.t("join_cta")}</a><a class="llrl-b llrl-b--ghost" href="${ds.loginUrl}">${this.t("sign_in")}</a></div>
        <p class="llrl-muted">${this.t("ln_guest_note")}</p>`}
      <h3>${this.t("ln_ways")}</h3><ul class="llrl-list">${ways.slice(0, 7)}</ul>
      ${rewards.length ? H`<h3>${this.t("ln_rewards")}</h3><ul class="llrl-list">${rewards}</ul>` : ""}${this.all()}`;
  };

  P.member = function () {
    var self = this, m = this.m, nt = m.next_tier, nx = this.next(), f = this.find("rewards", "referral_friend"), rr = this.find("earn_rules", "referral");
    var codes = (m.codes || []).filter(function (c) { return c.status === "issued"; }).slice(0, 3).map(function (c) {
      return H`<li><code>${c.code}</code><span class="llrl-muted">${self.t("amount_off", { amount: money(c.value_cents) })}</span>
        <button type="button" class="llrl-b llrl-b--sm llrl-b--ghost" data-act="copy" data-text="${c.code}">${self.t("copy")}</button></li>`;
    });
    var link = location.origin + this.ds.page + "?ref=" + encodeURIComponent(m.referral_code || "");
    return H`<div class="llrl-card">
        <div class="llrl-row"><span>${m.first_name ? this.t("hi", { name: m.first_name }) : this.t("member_card_label")}</span><span class="llrl-tier">${m.tier.name}</span></div>
        <p class="llrl-pts"><b>${n(m.points)}</b> ${this.t("points_balance")}</p>
        ${nt ? H`<div class="llrl-bar"><i style="width:${pct(m.tier_spend_cents, nt.min_spend_cents)}%"></i></div>` : ""}
        <p class="llrl-note">${nt ? this.t("spend_more", { amount: money(nt.remaining_cents), tier: nt.name }) : this.t("top_tier")}</p>
      </div>
      ${nx ? H`<div class="llrl-next">${m.points >= nx.points_cost
        ? H`<span>${this.t("next_reward_ready", { reward: nx.name })}</span>${this.units(nx)}
            <button type="button" class="llrl-b" data-act="redeem" data-key="${nx.key}" data-cost="${nx.points_cost}">${this.t("redeem")}</button>`
        : H`<span>${this.t("next_reward_progress", { points: n(nx.points_cost - m.points), reward: nx.name })}</span>
            <div class="llrl-bar llrl-bar--sm"><i style="width:${pct(m.points, nx.points_cost)}%"></i></div>`}</div>` : ""}
      ${codes.length ? H`<h3>${this.t("your_codes")}</h3><ul class="llrl-codes">${codes}</ul>` : ""}
      ${f && rr && m.referral_code ? H`<h3>${this.t("ln_refer", { amount: money(f.value_cents), points: n(rr.points) })}</h3>
        <div class="llrl-ref"><input type="text" readonly value="${link}" aria-label="${this.t("your_link")}">
        <button type="button" class="llrl-b llrl-b--sm" data-act="copy" data-text="${link}">${this.t("copy_link")}</button></div>` : ""}
      ${this.all()}`;
  };

  P.click = function (e) {
    var b = e.target.closest("[data-act]"), self = this;
    if (!b || b.disabled) return;
    if (b.dataset.act === "copy") {
      navigator.clipboard.writeText(b.dataset.text).then(function () {
        var t = b.textContent;
        b.textContent = self.t("copied");
        setTimeout(function () { b.textContent = t; }, 1500);
      });
    } else if (b.dataset.act === "redeem") {
      var sel = b.parentNode.querySelector('select[name="units"]'), u = sel ? Number(sel.value) : 1;
      if (b.dataset.armed != u) { // two taps: the first one (or a new amount) says what it costs
        b.dataset.armed = u;
        b.textContent = this.t("confirm_spend", { points: n(b.dataset.cost * u) });
        return;
      }
      b.disabled = true;
      b.textContent = this.t("redeeming");
      this.api("/redeem", { reward_key: b.dataset.key, request_key: rkey(), units: u }).then(function (x) {
        if (x.status !== "redeemed") {
          b.disabled = false;
          delete b.dataset.armed;
          b.textContent = self.t("redeem");
          return self.say(self.t(x.status === "insufficient_points" ? "not_enough" : "failed"));
        }
        self.say(self.t(x.code_status === "issued" ? "code_ready" : "code_pending", { code: x.code }));
        self.load();
      }, function () { b.disabled = false; self.say(self.t("failed")); });
    }
  };

  function boot() {
    // The rewards page block already shows all of this.
    if (document.querySelector(".llr")) return;
    document.querySelectorAll(".llrl").forEach(function (root) {
      if (root.dataset.llrlReady) return;
      root.dataset.llrlReady = "1";
      new L(root);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

/*
 * SOURCE for assets/wave-rewards-member.js (`npm run build:blocks`). The views
 * only a signed-in member sees: member card, rewards and redemption, referral
 * card, activity. Lazy-loaded by wave-rewards.js so logged-out visitors never
 * download it (and the main file stays under the 10 KB block limit).
 * Markup only through H`…` (escapes every value).
 */
window.LLR_MEMBER = function (P, U) {
  "use strict";
  var H = U.H, n = U.n, money = U.money, pct = U.pct, rkey = U.rkey, day = U.day;

  P.card = function () {
    var m = this.m, nt = m.next_tier, nx = this.next();
    return H`<section class="llr-top"><div class="llr-wrap"><div class="llr-mc">
      <div class="llr-mc__row"><span class="llr-mc__label">${m.first_name ? this.t("hi", { name: m.first_name }) : this.t("member_card_label")}</span>
        <span class="llr-badge llr-badge--${m.tier.key}">${m.tier.name}</span></div>
      <div class="llr-mc__pts"><b>${n(m.points)}</b> <span>${this.t("points_balance")}</span></div>
      ${nt ? H`<div class="llr-bar"><i style="width:${pct(m.tier_spend_cents, nt.min_spend_cents)}%"></i></div>` : ""}
      <p class="llr-mc__note">${nt ? this.t("spend_more", { amount: money(nt.remaining_cents), tier: nt.name }) : this.t("top_tier")}</p>
      ${nx ? H`<div class="llr-mc__next">${m.points >= nx.points_cost
        ? H`<span>${this.t("next_reward_ready", { reward: nx.name })}</span>${this.redeemBtn(nx, "llr-btn--light")}`
        : H`<span>${this.t("next_reward_progress", { points: n(nx.points_cost - m.points), reward: nx.name })}</span>`}</div>` : ""}
    </div></div></section>`;
  };

  P.redeemBtn = function (r, cls) {
    return H`<button type="button" class="llr-btn ${cls || ""}" data-act="redeem" data-key="${r.key}" data-cost="${r.points_cost}"${this.m.points < r.points_cost ? H` disabled` : ""}>${this.t("redeem")}</button>`;
  };

  // Dynamic rewards (0218: max_units, null = no cap) can be bought several at
  // once in one code. How many this member can afford, capped by the reward;
  // the picker lists at most 50.
  P.maxUnits = function (r) {
    var can = Math.floor(this.m.points / r.points_cost);
    return Math.min(r.max_units == null ? can : r.max_units, can, 50);
  };
  P.units = function (r) {
    var self = this, k = this.maxUnits(r), o = [];
    if (k < 2) return "";
    for (var i = 1; i <= k; i++) o.push(H`<option value="${i}">${self.t("units_option", { amount: money(r.value_cents * i), points: n(r.points_cost * i) })}</option>`);
    return H`<label class="llr-units"><span>${this.t("units_label")}</span><select name="units">${o}</select></label>`;
  };

  P.rewards = function () {
    var self = this, m = this.m;
    var cards = (this.s.rewards || []).filter(function (r) { return r.points_cost; }).map(function (r) {
      var short = r.points_cost - m.points;
      return H`<div class="llr-reward"><div class="llr-reward__value">${r.name}</div>
        <div class="llr-reward__cost">${self.t("points_cost", { points: n(r.points_cost) })}</div>
        <div class="llr-bar llr-bar--sm"><i style="width:${pct(m.points, r.points_cost)}%"></i></div>
        <p class="llr-muted">${short > 0 ? self.t("points_to_go", { points: n(short) }) : self.t("next_reward_ready", { reward: r.name })}</p>
        ${r.max_units !== 1 ? H`<p class="llr-muted">${self.t("units_hint", { points: n(r.points_cost), amount: money(r.value_cents) })}</p>` : ""}
        ${self.units(r)}${self.redeemBtn(r)}</div>`;
    });
    var codes = (m.codes || []).map(function (c) {
      return H`<li><code>${c.code}</code><span class="llr-muted">${self.t("amount_off", { amount: money(c.value_cents) })}${c.status === "pending" ? " · " + self.t("being_created") : ""}</span>
        ${c.status === "issued" ? H`<button type="button" class="llr-btn llr-btn--sm llr-btn--ghost" data-act="copy" data-text="${c.code}">${self.t("copy")}</button>` : ""}</li>`;
    });
    return H`<section class="llr-sec"><div class="llr-wrap"><h2 class="llr-h">${this.t("your_rewards")}</h2>
      <div class="llr-grid llr-grid--rewards">${cards}</div>
      ${codes.length ? H`<div class="llr-codes"><h3>${this.t("your_codes")}</h3><ul>${codes}</ul><p class="llr-muted">${this.t("rewards_note")}</p></div>` : ""}
    </div></section>`;
  };

  P.refer = function () {
    var f = this.find("rewards", "referral_friend"), r = this.find("earn_rules", "referral"), m = this.m;
    if (!f || !r) return "";
    var link = location.origin + location.pathname + "?ref=" + encodeURIComponent(m.referral_code);
    return H`<section class="llr-sec"><div class="llr-wrap"><div class="llr-refer">
      <div><h2 class="llr-h llr-h--left">${this.t("share_title", { amount: money(f.value_cents), points: n(r.points) })}</h2>
        <p>${this.t("refer_text", { amount: money(f.value_cents), points: n(r.points) })}</p></div>
      <div class="llr-inline"><input type="text" readonly value="${link}" aria-label="${this.t("your_link")}">
        <button type="button" class="llr-btn" data-act="copy" data-text="${link}">${this.t("copy_link")}</button></div>
    </div></div></section>`;
  };

  P.history = function () {
    var self = this, h = this.m.history || [];
    if (!h.length) return "";
    return H`<section class="llr-sec"><div class="llr-wrap llr-wrap--narrow"><h2 class="llr-h">${this.t("recent_activity")}</h2>
      <ul class="llr-activity">${h.map(function (e) {
        return H`<li><span><b>${(e.rule_key && self.t("rule_" + e.rule_key + "_title")) || self.t("reason_" + e.reason) || e.reason}</b><small>${day(e.at)}</small></span>
          <span class="${e.points > 0 ? "llr-plus" : "llr-minus"}">${e.points > 0 ? "+" : ""}${n(e.points)}</span></li>`;
      })}</ul></div></section>`;
  };

  P.redeem = function (b) {
    var self = this, sel = b.parentNode.querySelector('select[name="units"]'), u = sel ? Number(sel.value) : 1;
    // First tap (or the amount changed since): say what it costs.
    if (b.dataset.armed != u) {
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
  };
};

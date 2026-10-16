/*
 * SOURCE for assets/wave-rewards-ach.js (`npm run build:blocks`). Badges, the
 * monthly streak and challenges (0216, Phase 1b module 13). Lazy-loaded by
 * wave-rewards.js only when the proxy sends `achievements`, which it does
 * only for treatment members once Phase 1b is live: the holdout never
 * downloads or sees it. Markup only through H`…` (escapes every value).
 */
window.LLR_ACH = function (P, U) {
  "use strict";
  var H = U.H, n = U.n, money = U.money, pct = U.pct, day = U.day;
  function md(iso) { return day(iso.length === 10 ? iso + "T12:00:00" : iso, { month: "short", day: "numeric" }); }

  // Spend-type goals are cents; everything else is a count.
  P.amt = function (kind, v) { return kind === "big_order" || kind === "spend" ? money(v) : n(v); };

  P.ach = function () {
    var self = this, a = this.s.achievements, s = a.streak || {}, ch = a.challenges || [], b = a.badges || [];
    var streak = s.months > 0
      ? H`<p class="llr-streak"><b>${this.t("streak_months", { months: s.months })}</b> ${s.this_month ? this.t("streak_done", { date: md(s.keep_by) }) : this.t("streak_keep", { date: md(s.keep_by) })}</p>`
      : H`<p class="llr-streak">${this.t("streak_start")}</p>`;
    return H`<section class="llr-sec"><div class="llr-wrap"><h2 class="llr-h">${this.t("achievements_title")}</h2>
      ${streak}
      ${ch.length ? H`<h3 class="llr-h3">${this.t("challenges_title")}</h3><div class="llr-grid">${ch.map(function (c) {
        return H`<div class="llr-tile${c.completed ? " llr-tile--done" : ""}"><div class="llr-tile__body">
          <div class="llr-tile__head"><h3>${c.name}</h3><span class="llr-pill">+${n(c.points)}</span></div>
          ${c.description ? H`<p>${c.description}</p>` : ""}
          <div class="llr-bar llr-bar--sm"><i style="width:${pct(c.progress, c.target)}%"></i></div>
          <p class="llr-muted">${c.completed ? self.t("challenge_done", { points: n(c.points) })
            : self.t("progress", { have: self.amt(c.kind, c.progress), need: self.amt(c.kind, c.target) }) + " · " + self.t("challenge_ends", { date: md(c.ends_at) })}</p>
        </div></div>`;
      })}</div>` : ""}
      <h3 class="llr-h3">${this.t("badges_title")}</h3>
      <ul class="llr-badges">${b.map(function (x) {
        return H`<li class="llr-bdg${x.earned ? " is-earned" : ""}"><span class="llr-bdg__ico" aria-hidden="true"></span>
          <div><b>${x.name}</b><p>${x.description}</p>
          ${x.earned ? H`<p class="llr-done">${x.points ? self.t("badge_earned_pts", { points: n(x.points) }) : self.t("badge_earned")}</p>`
            : H`<div class="llr-bar llr-bar--sm"><i style="width:${pct(x.progress.have, x.progress.need)}%"></i></div>
              <p class="llr-muted">${self.t("progress", { have: self.amt(x.kind, x.progress.have), need: self.amt(x.kind, x.progress.need) })}${x.points ? " · +" + n(x.points) : ""}</p>`}
          </div></li>`;
      })}</ul>
    </div></section>`;
  };
};

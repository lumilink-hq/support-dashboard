/*
 * SOURCE for assets/wave-rewards-ref.js (`npm run build:blocks`). The referred
 * friend's invitation, lazy-loaded by wave-rewards.js only on ?ref= visits.
 * Markup only through H`…` (escapes every value).
 */
window.LLR_REF = function (page, H, money, friend) {
  "use strict";
  var slot = page.root.querySelector('[data-llr="friend"]');
  if (!slot) return;
  slot.innerHTML = H`<section class="llr-invite"><div class="llr-wrap"><div class="llr-invite__card">
    <div><span class="llr-pill llr-pill--on">${money(friend.value_cents)}</span>
      <h2 class="llr-h llr-h--left">${page.t("invited_title")}</h2><p>${page.t("invited_text", { amount: money(friend.value_cents) })}</p></div>
    <form class="llr-inline" data-friend><input type="email" name="email" required autocomplete="email" placeholder="you@example.com" aria-label="${page.t("your_email")}">
      <button type="submit" class="llr-btn">${page.t("get_code")}</button></form>
    <div class="llr-result" aria-live="polite"></div></div></div></section>`.s;
  var form = slot.querySelector("form"), out = slot.querySelector(".llr-result");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    out.textContent = "";
    page.api("/referral", { ref: page.ref, email: form.email.value }).then(function (x) {
      if (x.status !== "created") {
        out.textContent = page.t("ref_" + x.status) || page.t(x.status === "invalid" ? "invalid_email" : "failed");
        return;
      }
      form.remove();
      out.innerHTML = H`<p>${page.t("your_code")} <code>${x.code}</code>
        <button type="button" class="llr-btn llr-btn--sm llr-btn--ghost" data-act="copy" data-text="${x.code}">${page.t("copy")}</button></p>
        <p class="llr-muted">${page.t(x.code_status === "issued" ? "friend_code_ready" : "friend_code_pending")}</p>`.s;
    }, function () { out.textContent = page.t("failed"); });
  });
};

/*
 * SOURCE for assets/wave-rewards-ref.js (`npm run build:blocks`). The referred
 * friend's form, lazy-loaded by wave-rewards.js only on ?ref= visits.
 */
window.LLR_REF = function (page, h, money, friend) {
  "use strict";
  // A friend arriving on a referral link (and not the referrer themselves).
  var out = h("div", { class: "llr-result", "aria-live": "polite" });
  var email = h("input", { type: "email", required: true, autocomplete: "email", placeholder: "you@example.com", "aria-label": page.t("your_email") });
  var f = page.form(email, page.t("get_code"), function () {
    out.textContent = "";
    page.api("/referral", { ref: page.ref, email: email.value }).then(function (x) {
      if (x.status !== "created") return (out.textContent = page.t("ref_" + x.status) || page.t(x.status === "invalid" ? "invalid_email" : "failed"));
      f.remove();
      out.appendChild(h("p", null, page.t("your_code") + " ", h("span", { class: "llr-code" }, x.code), " ", page.copyBtn(x.code)));
      out.appendChild(h("p", { class: "llr-muted" }, page.t(x.code_status === "issued" ? "friend_code_ready" : "friend_code_pending")));
    }, function () { out.textContent = page.t("failed"); });
  });
  page.fill("referral", h("section", { class: "llr-referral" }, h("h2", { class: "llr-heading" }, page.t("invited_title")),
    h("p", null, page.t("invited_text", { amount: money(friend.value_cents) })), f, out));
};

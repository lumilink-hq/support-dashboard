/*
 * SOURCE for assets/wave-rewards-points.js (`npm run build:blocks`).
 * Keeps blocks/product-points.liquid's number in step with the selected variant.
 * Themes signal a variant change differently: Horizon themes (Tinker) dispatch
 * `variant:update` with the variant; others only change the product form's
 * `id` field. Both are handled; the price comes from the block's own JSON.
 */
(function () {
  "use strict";

  function update(el, id) {
    var prices = JSON.parse(el.querySelector('[data-llrp="prices"]').textContent), c = prices[id];
    if (c == null) return;
    var d = el.dataset, pts = Math.round((c * Number(d.ppd) * Number(d.mult)) / 100);
    el.querySelector('[data-llrp="text"]').textContent = d.tpl.replace("__N__", pts.toLocaleString("en-US"));
  }

  // The variant id in the product form of the block's own section (or the page's first).
  function formId(el) {
    var scope = el.closest(".shopify-section") || document;
    var f = scope.querySelector('form[action*="/cart/add"] [name="id"]') || document.querySelector('form[action*="/cart/add"] [name="id"]');
    return f && f.value;
  }

  function all(id) {
    document.querySelectorAll(".llrp").forEach(function (el) { update(el, id || formId(el)); });
  }

  document.addEventListener("variant:update", function (e) {
    var r = e.detail && e.detail.resource;
    all(r && r.id);
  });
  document.addEventListener("change", function (e) {
    if (e.target.closest && e.target.closest('form[action*="/cart/add"], variant-picker, variant-selects')) setTimeout(function () { all(); }, 0);
  });
})();

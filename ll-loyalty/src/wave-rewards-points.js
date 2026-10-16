/*
 * SOURCE for assets/wave-rewards-points.js (`npm run build:blocks`).
 * blocks/product-points.liquid:
 *  - keeps the points number in step with the selected variant. Themes signal a
 *    variant change differently: Horizon themes (Tinker) dispatch
 *    `variant:update` with the variant; others only change the product form's
 *    `id` field. Both are handled; the price comes from the block's own JSON.
 *  - "Use it on this order": two taps, then an unused code of the same value is
 *    reused, or one is redeemed through the app proxy (POST {proxy}/redeem), and
 *    the code is added to the cart's discount codes (the cart snippet's way).
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

  // --- redeem ---
  function json(url, body) {
    var o = { credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body) { o.method = "POST"; o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function rkey() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }

  // An issued, unused code of this value from an earlier redeem, else a new one.
  function code(proxy, key, value) {
    return json(proxy + "/state").then(function (s) {
      var c = ((s.member && s.member.codes) || []).filter(function (c) { return c.status === "issued" && c.value_cents === value; })[0];
      if (c) return c.code;
      return json(proxy + "/redeem", { reward_key: key, request_key: rkey(), units: 1 }).then(function (x) {
        if (x.status !== "redeemed" || !x.code) throw 0;
        return x.code;
      });
    });
  }

  // Adds the code to the cart's codes; resolves true when the cart took it.
  function apply(c) {
    return json("/cart.js").then(function (cart) {
      var codes = (cart.discount_codes || []).map(function (d) { return d.code; }).filter(function (x) { return x !== c; });
      return json("/cart/update.js", { discount: codes.concat(c).join(",") });
    }).then(function (cart) {
      return (cart.discount_codes || []).some(function (d) { return d.code.toUpperCase() === c.toUpperCase(); });
    }, function () { return false; });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest('[data-llrp="redeem"]');
    if (!b || b.disabled) return;
    var d = b.dataset, el = b.closest(".llrp"), status = el.querySelector('[data-llrp="status"]');
    if (!d.armed) { // first tap says what it costs
      d.armed = 1;
      b.textContent = d.confirm;
      return;
    }
    b.disabled = true;
    b.textContent = d.working;
    code(el.dataset.proxy || "/apps/loyalty", d.key, Number(d.value)).then(function (c) {
      return apply(c).then(function (ok) {
        status.textContent = (ok ? d.applied : d.saved).replace("__CODE__", c);
        b.hidden = true;
      });
    }).catch(function () {
      delete d.armed;
      b.disabled = false;
      b.textContent = d.label;
      status.textContent = d.failed;
    });
  });
})();

/*
 * Course admin, Payment cards: keep "N cards will show" in step with the
 * card switches and prices while the admin edits. The server repeats every
 * rule on save (apps.payments.plans); this is only the live count.
 */
(function () {
  "use strict";

  var MAX_CARDS = 4;

  function perRow(count) {
    return Math.min(Math.max(count, 2), MAX_CARDS);
  }

  function priceOf(input) {
    var value = input ? parseFloat(String(input.value || "").replace(/,/g, "")) : NaN;
    return Number.isFinite(value) ? value : 0;
  }

  function init(panel) {
    var plans;
    try {
      plans = JSON.parse(panel.getAttribute("data-payment-cards") || "[]");
    } catch (error) {
      return;
    }
    var countNode = panel.querySelector('[data-role="count"]');
    var detailNode = panel.querySelector('[data-role="detail"]');
    var inputs = plans.map(function (plan) {
      return {
        label: plan.label,
        enabled: document.getElementById(plan.enabled),
        price: document.getElementById(plan.price),
      };
    });

    function update() {
      var shown = inputs.filter(function (item) {
        return item.enabled && item.enabled.checked;
      });
      var unpriced = shown.filter(function (item) {
        return priceOf(item.price) <= 0;
      });
      var count = shown.length;
      countNode.textContent = count + (count === 1 ? " card will show" : " cards will show");
      var detail;
      if (unpriced.length) {
        detail = "Set a price above ₹0 for: " + unpriced.map(function (item) { return item.label; }).join(", ") + ".";
      } else if (count === 0) {
        detail = "Online purchase is off for this course.";
      } else if (count === 1) {
        detail = "Show 2 to " + MAX_CARDS + " cards, or none to turn off online purchase.";
      } else {
        detail = "Laid out " + perRow(count) + " per row.";
      }
      detailNode.textContent = detail;
      panel.classList.toggle("is-invalid", count === 1 || unpriced.length > 0);
    }

    inputs.forEach(function (item) {
      [item.enabled, item.price].forEach(function (input) {
        if (input) {
          input.addEventListener("change", update);
          input.addEventListener("input", update);
        }
      });
    });
    update();
  }

  function start() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-payment-cards]"), init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

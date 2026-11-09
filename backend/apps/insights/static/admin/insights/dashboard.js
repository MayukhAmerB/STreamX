/*
 * Insights dashboard: fetches the dashboard JSON for the selected range and
 * renders sections, KPI tiles and charts (via carbon-viz.js).
 *
 * - One filter row (range switcher + refresh) scopes everything below it.
 * - Refetch keeps the previous render, dimmed; no skeleton flash.
 * - The selected range lives in the URL hash (#range-7d).
 * - Charts re-render on resize (ResizeObserver) and on theme change
 *   (data-theme on <html> and the OS colour-scheme preference).
 * - Data strings are only ever inserted with textContent.
 *
 * Test hook: if window.__INSIGHTS_FIXTURE__ is defined (an object, or a
 * function taking the range and returning an object or a promise), it is used
 * instead of fetching. Harmless in production, where it is never set.
 */
(function () {
  "use strict";

  var root = document.getElementById("insights-dashboard");
  var CV = window.CarbonViz;
  if (!root || !CV) return;

  var SECTION_DEFAULTS = [
    ["business", "Business"],
    ["learning", "Learning"],
    ["outreach", "Outreach"],
    ["infrastructure", "Infrastructure"],
    ["streaming", "Streaming"]
  ];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DASH = "\u2014";

  var endpoint = root.getAttribute("data-endpoint") || "";
  var switcher = document.getElementById("insights-range-switcher");
  var rangeButtons = switcher ? Array.prototype.slice.call(switcher.querySelectorAll("[data-range]")) : [];
  var validRanges = rangeButtons.map(function (b) { return b.getAttribute("data-range"); });
  var defaultRange = root.getAttribute("data-default-range") || validRanges[0] || "7d";
  var updatedText = document.querySelector("#insights-updated .insights-updated__text");
  var refreshButton = document.getElementById("insights-refresh");

  var state = {
    range: defaultRange,
    data: null,
    error: null,
    seq: 0,
    controller: null,
    tableOpen: {}
  };

  // Drawables: chart plots and sparklines, re-rendered on resize/theme change.
  var drawables = [];
  var tokens = null;
  var uid = 0;

  /* ------------------------------------------------------------- helpers */

  function h(tag, className, parent, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
  }

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function nextId(prefix) {
    uid += 1;
    return prefix + "-" + uid;
  }

  function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 48) || "x";
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* --------------------------------------------------------------- range */

  function rangeFromHash() {
    var m = /^#range-([A-Za-z0-9_-]+)$/.exec(window.location.hash || "");
    if (m && validRanges.indexOf(m[1]) >= 0) return m[1];
    return null;
  }

  function syncSwitcher() {
    rangeButtons.forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-range") === state.range ? "true" : "false");
    });
  }

  function writeHash(range) {
    var hash = "#range-" + range;
    if (window.location.hash === hash) return;
    try {
      window.history.replaceState(null, "", hash);
    } catch (e) {
      window.location.hash = hash;
    }
  }

  /* ---------------------------------------------------------------- fetch */

  function getData(range, signal) {
    var fixture = window.__INSIGHTS_FIXTURE__;
    if (fixture !== undefined) {
      return new Promise(function (resolve) { window.setTimeout(resolve, 0); }).then(function () {
        return typeof fixture === "function" ? fixture(range) : fixture;
      });
    }
    if (!endpoint) return Promise.reject(new Error("The dashboard has no data URL configured."));
    var url = new URL(endpoint, window.location.href);
    url.searchParams.set("range", range);
    return fetch(url.toString(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: signal
    }).then(function (res) {
      var type = res.headers.get("content-type") || "";
      if (res.status === 401 || res.status === 403 || (res.ok && type.indexOf("json") < 0)) {
        throw new Error("Your session may have expired. Reload the page to sign in again.");
      }
      if (!res.ok) throw new Error("The server responded with " + res.status + ".");
      return res.json();
    });
  }

  function load(range) {
    if (validRanges.length && validRanges.indexOf(range) < 0) range = defaultRange;
    state.range = range;
    syncSwitcher();
    writeHash(range);

    if (state.controller) state.controller.abort();
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    state.controller = controller;
    var seq = ++state.seq;

    if (state.data) root.classList.add("is-refreshing");
    root.setAttribute("aria-busy", "true");
    if (refreshButton) refreshButton.setAttribute("aria-busy", "true");

    getData(range, controller ? controller.signal : undefined)
      .then(function (data) {
        if (seq !== state.seq) return;
        if (!data || !Array.isArray(data.sections)) throw new Error("The dashboard data was not in the expected format.");
        state.data = data;
        state.error = null;
        renderAll();
      })
      .catch(function (err) {
        if (seq !== state.seq || (err && err.name === "AbortError")) return;
        state.error = err || new Error("Unknown error");
        renderError();
      })
      .then(function () {
        if (seq !== state.seq) return;
        root.classList.remove("is-refreshing");
        root.setAttribute("aria-busy", "false");
        if (refreshButton) refreshButton.removeAttribute("aria-busy");
      });
  }

  /* --------------------------------------------------------- updated at */

  function setUpdated(iso) {
    if (!updatedText) return;
    clear(updatedText);
    if (!iso) {
      updatedText.textContent = "Not updated yet";
      return;
    }
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
      updatedText.textContent = "Updated";
      return;
    }
    var now = new Date();
    var hhmm = (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
    var sameDay = d.toDateString() === now.toDateString();
    var label = sameDay ? hhmm : d.getDate() + " " + MONTHS[d.getMonth()] + ", " + hhmm;
    updatedText.appendChild(document.createTextNode("Updated "));
    var t = h("time", null, updatedText, label);
    t.setAttribute("datetime", iso);
  }

  /* -------------------------------------------------------- notifications */

  function notification(kind, title, text, action) {
    var box = h("div", "insights-notification insights-notification--" + kind);
    box.setAttribute("role", kind === "error" ? "alert" : "status");
    var iconName = kind === "error" ? "error" : kind === "warning" ? "warning" : "information";
    box.appendChild(CV.icon(iconName));
    var body = h("div", "insights-notification__text", box);
    if (title) h("strong", null, body, title);
    if (text) body.appendChild(document.createTextNode(text));
    if (action) {
      var btn = h("button", "insights-ghost-btn", box, action.label);
      btn.type = "button";
      btn.addEventListener("click", action.onClick);
    }
    return box;
  }

  /* ------------------------------------------------------------ sections */

  function sectionShell(id, title, description, note) {
    var section = h("section", "insights-section");
    section.id = "insights-section-" + slug(id);
    var head = h("header", "insights-section__head", section);
    var h2 = h("h2", "insights-section__title", head, title);
    h2.id = section.id + "-title";
    section.setAttribute("aria-labelledby", h2.id);
    if (description) h("p", "insights-section__desc", head, description);
    if (note) {
      var n = h("p", "insights-section__note", head);
      n.appendChild(CV.icon("information"));
      h("span", null, n, note);
    }
    var body = h("div", "insights-section__body", section);
    return { section: section, body: body };
  }

  function renderPlaceholders() {
    clear(root);
    h("div", "insights-alert-slot", root);
    SECTION_DEFAULTS.forEach(function (d) {
      var s = sectionShell(d[0], d[1]);
      var p = h("p", "insights-loading", s.body, "Loading\u2026");
      p.setAttribute("role", "status");
      root.appendChild(s.section);
    });
  }

  function renderError() {
    var err = state.error;
    var message = (err && err.message) || "Something went wrong.";
    var box = notification("error", "Couldn\u2019t load the dashboard.", " " + message, {
      label: "Retry",
      onClick: function () { load(state.range); }
    });
    if (!state.data) {
      clear(root);
      drawables = [];
      root.appendChild(box);
      if (updatedText) updatedText.textContent = "Not updated";
      return;
    }
    var slot = root.querySelector(".insights-alert-slot");
    if (slot) {
      clear(slot);
      slot.appendChild(box);
    }
  }

  function renderAll() {
    var data = state.data;
    drawables = [];
    if (resizeObserver) resizeObserver.disconnect();
    clear(root);
    h("div", "insights-alert-slot", root);
    data.sections.forEach(function (sec) {
      root.appendChild(renderSection(sec));
    });
    setUpdated(data.generated_at);
    drawAll(true);
  }

  function renderSection(sec) {
    var s = sectionShell(sec.id, sec.title || sec.id, sec.description, sec.note);
    if (sec.available === false) {
      s.body.appendChild(notification("info", "Not available.", " " + (sec.unavailable_reason || "This section has no data source configured."), null));
      return s.section;
    }
    var kpis = Array.isArray(sec.kpis) ? sec.kpis : [];
    var charts = Array.isArray(sec.charts) ? sec.charts : [];
    if (kpis.length) {
      var row = h("div", "insights-kpis", s.body);
      kpis.forEach(function (k) { row.appendChild(renderKpi(k)); });
    }
    if (charts.length) {
      var grid = h("div", "insights-charts", s.body);
      charts.forEach(function (c) { grid.appendChild(renderChart(sec, c)); });
    }
    if (!kpis.length && !charts.length) {
      h("p", "insights-loading", s.body, "Nothing to show for this period.");
    }
    return s.section;
  }

  /* ----------------------------------------------------------- KPI tiles */

  function formatDelta(pct) {
    var abs = Math.abs(pct);
    var text = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(abs) + "%";
    if (pct > 0) return "+" + text;
    if (pct < 0) return "\u2212" + text;
    return text;
  }

  function renderKpi(k) {
    var tile = h("div", "insights-kpi");
    tile.setAttribute("role", "group");
    var labelId = nextId("insights-kpi");
    var label = h("div", "insights-kpi__label", tile, k.label);
    label.id = labelId;
    tile.setAttribute("aria-labelledby", labelId);

    // A "status" KPI (e.g. LiveKit health) shows its label, not the raw 0/1.
    var isStatus = k.unit === "status" && !!k.status_label;
    var valueText = isStatus ? k.status_label : CV.format(k.value, k.unit, "tile");
    var hasValue = isStatus || isNum(k.value);
    var value = h("div", "insights-kpi__value" + (hasValue ? "" : " is-null"), tile, valueText);
    var full = isStatus ? valueText : CV.format(k.value, k.unit, "full");
    if (full !== valueText) value.title = full;
    if (!hasValue) value.setAttribute("aria-label", "No data");

    if (isNum(k.delta_pct)) {
      var meta = h("div", "insights-kpi__meta", tile);
      var dir = k.delta_pct > 0 ? "up" : k.delta_pct < 0 ? "down" : null;
      var tone = "";
      if (dir && (k.delta_good_direction === "up" || k.delta_good_direction === "down")) {
        tone = dir === k.delta_good_direction ? " is-good" : " is-bad";
      }
      var delta = h("span", "insights-delta" + tone, meta);
      if (dir) delta.appendChild(CV.icon(dir === "up" ? "arrow-up" : "arrow-down"));
      var srPrefix = dir === "up" ? "Up " : dir === "down" ? "Down " : "No change, ";
      h("span", "cviz-sr", delta, srPrefix);
      h("span", null, delta, formatDelta(k.delta_pct));
      if (tone) h("span", "cviz-sr", delta, tone === " is-good" ? " (good)" : " (needs attention)");
      if (k.period_label) h("span", "insights-kpi__period", meta, k.period_label);
    }

    var trend = Array.isArray(k.trend) ? k.trend : null;
    if (trend && trend.filter(isNum).length >= 2) {
      var spark = h("div", "insights-kpi__spark", tile);
      spark.setAttribute("aria-hidden", "true");
      drawables.push({
        el: spark,
        lastWidth: -1,
        draw: function () { CV.sparkline(spark, trend, { tokens: tokens }); }
      });
    }

    if (k.status && CV.statusNames[k.status]) {
      var foot = h("div", "insights-kpi__foot", tile);
      var chip = h("span", "insights-status insights-status--" + k.status, foot);
      chip.appendChild(CV.icon(CV.statusIcons[k.status]));
      h("span", null, chip, k.status_label || CV.statusNames[k.status]);
    }

    if (k.hint) h("p", "insights-kpi__hint", tile, k.hint);
    return tile;
  }

  /* -------------------------------------------------------------- charts */

  function setToggle(btn, showingTable) {
    clear(btn);
    btn.appendChild(CV.icon(showingTable ? "chart-line" : "table"));
    h("span", null, btn, showingTable ? "Chart" : "Table");
    btn.setAttribute("aria-pressed", showingTable ? "true" : "false");
    btn.setAttribute("aria-label", showingTable ? "Show chart" : "Show as table");
  }

  function renderChart(sec, chart) {
    var key = slug(sec.id) + "/" + slug(chart.id);
    var fig = h("figure", "insights-chart");
    var head = h("div", "insights-chart__head", fig);
    var titles = h("div", "insights-chart__titles", head);
    var titleEl = h("h3", "insights-chart__title", titles, chart.title || "");
    titleEl.id = nextId("insights-chart-title");
    fig.setAttribute("aria-labelledby", titleEl.id);
    if (chart.subtitle) h("p", "insights-chart__subtitle", titles, chart.subtitle);

    var body = h("div", "insights-chart__body", fig);

    if (CV.isEmpty(chart)) {
      h("p", "insights-chart__empty", body, chart.empty_message || "No data for this period.");
      return fig;
    }

    var toggle = h("button", "insights-ghost-btn", head);
    toggle.type = "button";
    var plot = h("div", "insights-chart__plot", body);
    var tableWrap = h("div", "insights-chart__table", body);
    tableWrap.id = nextId("insights-chart-table");
    tableWrap.setAttribute("tabindex", "0");
    tableWrap.setAttribute("role", "region");
    tableWrap.setAttribute("aria-label", (chart.title || "Chart") + ", table view");
    tableWrap.appendChild(CV.table(chart));
    toggle.setAttribute("aria-controls", tableWrap.id);

    var entry = {
      el: plot,
      lastWidth: -1,
      draw: function () { CV.render(plot, chart, { tokens: tokens }); }
    };
    drawables.push(entry);

    function apply(showTable) {
      state.tableOpen[key] = showTable;
      plot.hidden = showTable;
      tableWrap.hidden = !showTable;
      setToggle(toggle, showTable);
      if (!showTable) {
        entry.lastWidth = -1;
        scheduleDraw(entry);
      }
    }
    toggle.addEventListener("click", function () { apply(!state.tableOpen[key]); });
    plot.hidden = !!state.tableOpen[key];
    tableWrap.hidden = !state.tableOpen[key];
    setToggle(toggle, !!state.tableOpen[key]);
    return fig;
  }

  /* ------------------------------------------------------------- drawing */

  var resizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(function (entries) {
        entries.forEach(function (e) {
          for (var i = 0; i < drawables.length; i++) {
            if (drawables[i].el === e.target) { scheduleDraw(drawables[i]); break; }
          }
        });
      })
    : null;

  var pending = [];
  var frame = 0;
  function scheduleDraw(entry) {
    if (pending.indexOf(entry) < 0) pending.push(entry);
    if (!frame) {
      frame = window.requestAnimationFrame(function () {
        frame = 0;
        var list = pending;
        pending = [];
        list.forEach(function (d) { draw(d, false); });
      });
    }
  }

  function draw(entry, force) {
    if (!entry.el.isConnected) return;
    var w = entry.el.clientWidth;
    if (!w) return; // hidden (table view); drawn again when shown
    if (!force && w === entry.lastWidth) return;
    entry.lastWidth = w;
    entry.draw();
  }

  function drawAll(observe) {
    tokens = CV.readTokens(root);
    drawables.forEach(function (d) {
      draw(d, true);
      if (observe && resizeObserver) resizeObserver.observe(d.el);
    });
  }

  if (!resizeObserver) {
    window.addEventListener("resize", function () { drawables.forEach(scheduleDraw); });
  }

  /* Theme changes: admin toggle (data-theme on <html>) and the OS preference. */
  // A timer rather than requestAnimationFrame: rAF is paused in background
  // tabs, and a theme flip there should still be drawn by the time it's seen.
  var themeTimer = 0;
  function onThemeChange() {
    if (themeTimer) return;
    themeTimer = window.setTimeout(function () {
      themeTimer = 0;
      drawAll(false);
    }, 16);
  }
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", onThemeChange);
    else if (mq.addListener) mq.addListener(onThemeChange);
  }
  // Text measurement depends on the web font: redraw once it has loaded.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { if (state.data) drawAll(false); });
  }

  /* -------------------------------------------------------------- events */

  rangeButtons.forEach(function (b) {
    b.addEventListener("click", function () {
      var r = b.getAttribute("data-range");
      if (r !== state.range || state.error) load(r);
    });
  });
  if (refreshButton) {
    refreshButton.addEventListener("click", function () { load(state.range); });
  }
  window.addEventListener("hashchange", function () {
    var r = rangeFromHash();
    if (r && r !== state.range) load(r);
  });

  /* ---------------------------------------------------------------- boot */

  state.range = rangeFromHash() || defaultRange;
  renderPlaceholders();
  load(state.range);
})();

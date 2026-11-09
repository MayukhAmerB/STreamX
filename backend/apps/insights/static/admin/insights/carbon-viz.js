/*
 * carbon-viz.js: a small, dependency-free SVG chart kit for the insights
 * dashboard. IBM Carbon look; marks follow the house data-viz method:
 *
 *   - thin marks: bars <= 24px, 4px rounded data end, square at the baseline;
 *     2px lines; >= 8px markers with a 2px surface ring; area fill at 10%
 *   - 2px surface gap between touching marks; solid 1px hairline gridlines
 *   - a legend only for two or more series; selective direct labels
 *   - text never wears the series colour (labels use text tokens)
 *   - time series: crosshair + one tooltip listing every series at that x;
 *     bars and segments: the mark (its whole row/band) is the hit target
 *   - keyboard focus shows exactly what hover shows; a polite live region
 *     announces it; every chart has a table twin (CarbonViz.table)
 *   - data strings are inserted with textContent only, never innerHTML
 *
 * Colours are read from CSS custom properties on the chart's root at render
 * time (CarbonViz.readTokens), so callers re-render on theme change.
 *
 * Public API (window.CarbonViz):
 *   render(container, chart, opts)   timeseries | ranked | segmented
 *   sparkline(container, values, opts)
 *   table(chart)                     -> <table> twin of a chart
 *   isEmpty(chart)
 *   format(value, unit, mode)        mode: "full" | "tile"
 *   formatTime(iso, bucket, mode)    mode: "tick" | "full"
 *   readTokens(element)
 */
(function (global) {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var DASH = "\u2014";
  var STATUS_NAMES = { good: "Good", warning: "Warning", critical: "Critical", neutral: "Neutral" };
  var STATUS_ICONS = { good: "checkmark", warning: "warning", critical: "error", neutral: "information" };

  /* ------------------------------------------------------------------ DOM */

  function svgEl(tag, attrs, parent) {
    var node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] !== null && attrs[key] !== undefined) {
          node.setAttribute(key, String(attrs[key]));
        }
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function htmlEl(tag, className, parent, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (parent) parent.appendChild(node);
    return node;
  }

  function icon(name, extraClass) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "enterprise-icon" + (extraClass ? " " + extraClass : ""));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    var use = document.createElementNS(SVGNS, "use");
    use.setAttribute("href", "#icon-" + name);
    svg.appendChild(use);
    return svg;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* --------------------------------------------------------------- tokens */

  function readTokens(element) {
    var cs = global.getComputedStyle(element);
    function v(name, fallback) {
      var value = cs.getPropertyValue(name).trim();
      return value || fallback;
    }
    return {
      series: [v("--viz-series-1", "#0f62fe"), v("--viz-series-2", "#009d9a"), v("--viz-series-3", "#ba4e00")],
      status: {
        good: v("--viz-good", "#24a148"),
        warning: v("--viz-warning", "#f1c21b"),
        critical: v("--viz-critical", "#da1e28"),
        neutral: v("--viz-neutral", "#8d8d8d")
      },
      surface: v("--viz-surface", "#f4f4f4"),
      textPrimary: v("--viz-text-primary", "#161616"),
      textSecondary: v("--viz-text-secondary", "#525252"),
      axisText: v("--viz-axis-text", "#6f6f6f"),
      grid: v("--viz-grid", "#e0e0e0"),
      baseline: v("--viz-baseline", "#8d8d8d"),
      deemph: v("--viz-deemph", "#8d8d8d"),
      hoverWash: v("--viz-hover-wash", "rgba(141,141,141,0.16)"),
      onFillLight: v("--viz-on-fill-light", "#ffffff"),
      onFillDark: v("--viz-on-fill-dark", "#161616"),
      font: cs.fontFamily || "IBM Plex Sans, Helvetica Neue, Arial, sans-serif"
    };
  }

  /* Relative luminance / contrast, to pick white or near-black inside a fill. */
  function parseColor(str) {
    var s = String(str).trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var hex = m[1];
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var parts = m[1].split(/[\s,\/]+/).filter(Boolean);
      return [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2])];
    }
    return [128, 128, 128];
  }

  function luminance(rgb) {
    var c = rgb.map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrast(a, b) {
    var la = luminance(parseColor(a));
    var lb = luminance(parseColor(b));
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function labelOnFill(fill, tokens) {
    return contrast(tokens.onFillLight, fill) >= contrast(tokens.onFillDark, fill) ? tokens.onFillLight : tokens.onFillDark;
  }

  /* ---------------------------------------------------------- measurement */

  var measureCtx = null;
  function textWidth(str, size, weight, family) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    measureCtx.font = (weight || 400) + " " + size + "px " + family;
    return measureCtx.measureText(String(str)).width;
  }

  function ellipsize(str, maxWidth, size, weight, family) {
    str = String(str);
    if (textWidth(str, size, weight, family) <= maxWidth) return str;
    var lo = 0;
    var hi = str.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (textWidth(str.slice(0, mid) + "\u2026", size, weight, family) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? str.slice(0, lo).replace(/\s+$/, "") + "\u2026" : "";
  }

  /* ----------------------------------------------------------- formatting */

  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  var nfCache = {};
  function nf(min, max) {
    var key = min + ":" + max;
    if (!nfCache[key]) {
      nfCache[key] = new Intl.NumberFormat("en-IN", { minimumFractionDigits: min, maximumFractionDigits: max });
    }
    return nfCache[key];
  }

  /* Indian compact scale: K (thousand), L (lakh), Cr (crore). */
  function compactIndian(n, decimals) {
    var d = decimals === undefined ? 1 : decimals;
    var abs = Math.abs(n);
    var sign = n < 0 ? "-" : "";
    var scales = [[1e7, "Cr"], [1e5, "L"], [1e3, "K"]];
    for (var i = 0; i < scales.length; i++) {
      if (abs >= scales[i][0]) {
        var scaled = abs / scales[i][0];
        // 99,960 rounds to "100K": promote it to the next scale instead.
        if (i > 0 && Number(scaled.toFixed(d)) * scales[i][0] >= scales[i - 1][0]) {
          scaled = abs / scales[i - 1][0];
          return sign + nf(0, d).format(Number(scaled.toFixed(d))) + scales[i - 1][1];
        }
        return sign + nf(0, d).format(Number(scaled.toFixed(d))) + scales[i][1];
      }
    }
    return sign + nf(0, d).format(abs);
  }

  /*
   * format(value, unit, mode)
   *   "full": tables, tooltips (\u20b91,23,456 / 1,234 / 12.3% / 123 ms / 1.2 s)
   *   "tile": stat-tile values and bar-tip labels (auto-compact >= 1 lakh)
   */
  function format(value, unit, mode) {
    if (!isNum(value)) return DASH;
    mode = mode || "full";
    var compact = mode === "tile" && Math.abs(value) >= 1e5;
    switch (unit) {
      case "inr":
        if (compact) return (value < 0 ? "-" : "") + "\u20b9" + compactIndian(Math.abs(value));
        return (value < 0 ? "-" : "") + "\u20b9" + nf(0, 0).format(Math.abs(value));
      case "percent":
        // Availability-style figures need the second decimal: 99.95% must not read as 100.0%.
        var pd = value >= 99 && value < 100 ? 2 : 1;
        return nf(pd, pd).format(value) + "%";
      case "ms":
        if (Math.abs(value) >= 1000) return nf(1, 1).format(value / 1000) + " s";
        return nf(0, 0).format(value) + " ms";
      case "per_second":
        return nf(1, 1).format(value) + "/s";
      case "cores":
        return nf(2, 2).format(value) + (Math.abs(value) === 1 ? " core" : " cores");
      default:
        if (compact) return compactIndian(value);
        return nf(0, Number.isInteger(value) ? 0 : 1).format(value);
    }
  }

  /* Fewest decimals that print every multiple of `step` exactly (0.25 -> 2). */
  function decimalsFor(step) {
    if (!(step > 0)) return 0;
    for (var d = 0; d < 4; d++) {
      var scaled = step * Math.pow(10, d);
      if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return d;
    }
    return 3;
  }

  /* One style per axis: full under 10,000, compact on an axis that reaches it. */
  function axisFormatter(unit, scale) {
    var maxAbs = Math.max(Math.abs(scale.min), Math.abs(scale.max));
    var step = scale.step;
    var d = decimalsFor(step);
    switch (unit) {
      case "inr":
        if (maxAbs >= 10000) {
          return function (v) { return (v < 0 ? "-" : "") + "\u20b9" + compactIndian(Math.abs(v), 1); };
        }
        return function (v) { return (v < 0 ? "-" : "") + "\u20b9" + nf(0, d).format(Math.abs(v)); };
      case "percent":
        return function (v) { return nf(0, d).format(v) + "%"; };
      case "ms":
        if (maxAbs >= 1000) {
          var ds = decimalsFor(step / 1000);
          return function (v) { return nf(0, ds).format(v / 1000) + " s"; };
        }
        return function (v) { return nf(0, d).format(v) + " ms"; };
      case "per_second":
        return function (v) { return nf(0, d).format(v) + "/s"; };
      case "cores":
        return function (v) { return nf(0, Math.max(d, 0)).format(v); };
      default:
        if (maxAbs >= 10000) return function (v) { return compactIndian(v, 1); };
        return function (v) { return nf(0, d).format(v); };
    }
  }

  /* ----------------------------------------------------------------- time */

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /*
   * Bucket timestamps carry the server's wall-clock (e.g. +05:30). Read the
   * wall-clock straight off the string so a day bucket never slides into the
   * previous date in another browser timezone; UTC ("Z") stamps are shown in
   * the browser's local time instead.
   */
  function parseWall(iso) {
    var s = String(iso || "");
    if (/(Z|[+-]00:?00)$/i.test(s)) {
      var dt = new Date(s);
      if (!isNaN(dt.getTime())) {
        return { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes() };
      }
    }
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
    if (!m) return null;
    return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0 };
  }

  function weekday(w) {
    return WEEKDAYS[new Date(w.y, w.mo, w.d).getDay()];
  }

  function formatTime(iso, bucket, mode) {
    var w = parseWall(iso);
    if (!w) return String(iso || "");
    var date = w.d + " " + MONTHS[w.mo];
    var time = pad2(w.h) + ":" + pad2(w.mi);
    if (bucket === "hour") {
      if (mode === "full") return weekday(w) + " " + date + ", " + time;
      return w.h === 0 && w.mi === 0 ? date : time;
    }
    if (mode === "full") return weekday(w) + " " + date + " " + w.y;
    return date;
  }

  /* --------------------------------------------------------------- scales */

  function niceTicks(lo, hi, count, integer) {
    if (!(hi > lo)) hi = lo + (integer ? Math.max(1, count) : 1);
    var raw = (hi - lo) / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    step *= mag;
    if (integer) step = Math.max(1, Math.ceil(step));
    var min = Math.floor(lo / step) * step;
    var max = Math.ceil(hi / step) * step;
    var ticks = [];
    for (var i = 0, v = min; v <= max + step * 1e-6 && i < 50; i++, v = min + i * step) {
      ticks.push(Number(v.toPrecision(12)));
    }
    return { ticks: ticks, step: step, min: min, max: max };
  }

  /* ---------------------------------------------------------------- paths */

  /* Vertical column: 4px rounded data end, square at the baseline. */
  function columnPath(x, yBase, yEnd, w, r) {
    var h = Math.abs(yBase - yEnd);
    var rr = Math.max(0, Math.min(r, w / 2, h));
    if (yEnd <= yBase) {
      return "M" + x + "," + yBase + "V" + (yEnd + rr) +
        "A" + rr + "," + rr + " 0 0 1 " + (x + rr) + "," + yEnd +
        "H" + (x + w - rr) +
        "A" + rr + "," + rr + " 0 0 1 " + (x + w) + "," + (yEnd + rr) +
        "V" + yBase + "Z";
    }
    return "M" + x + "," + yBase + "V" + (yEnd - rr) +
      "A" + rr + "," + rr + " 0 0 0 " + (x + rr) + "," + yEnd +
      "H" + (x + w - rr) +
      "A" + rr + "," + rr + " 0 0 0 " + (x + w) + "," + (yEnd - rr) +
      "V" + yBase + "Z";
  }

  /* Horizontal bar growing right from xBase: rounded right end, square left. */
  function barPath(xBase, xEnd, y, h, r) {
    var w = xEnd - xBase;
    var rr = Math.max(0, Math.min(r, h / 2, w));
    return "M" + xBase + "," + y + "H" + (xEnd - rr) +
      "A" + rr + "," + rr + " 0 0 1 " + xEnd + "," + (y + rr) +
      "V" + (y + h - rr) +
      "A" + rr + "," + rr + " 0 0 1 " + (xEnd - rr) + "," + (y + h) +
      "H" + xBase + "Z";
  }

  function crisp(v) {
    return Math.round(v) + 0.5;
  }

  /* -------------------------------------------------------------- tooltip */

  function makeTooltip(container) {
    var tip = htmlEl("div", "cviz-tooltip", container);
    tip.hidden = true;
    tip.setAttribute("aria-hidden", "true");
    return tip;
  }

  /* rows: [{color, value, label}] -> value leads (strong), label follows. */
  function fillTooltip(tip, head, rows, statusInfo) {
    clear(tip);
    if (head) htmlEl("div", "cviz-tooltip__head", tip, head);
    rows.forEach(function (row) {
      var r = htmlEl("div", "cviz-tooltip__row", tip);
      var key = htmlEl("span", "cviz-tooltip__key", r);
      key.style.background = row.color;
      htmlEl("span", "cviz-tooltip__value", r, row.value);
      htmlEl("span", "cviz-tooltip__label", r, row.label);
    });
    if (statusInfo) {
      var s = htmlEl("div", "cviz-tooltip__status", tip);
      var ic = icon(STATUS_ICONS[statusInfo.status] || "information");
      ic.style.color = statusInfo.color;
      s.appendChild(ic);
      htmlEl("span", null, s, statusInfo.label);
    }
  }

  function placeTooltip(tip, container, anchorX, anchorY, centered) {
    tip.hidden = false;
    var cw = container.clientWidth;
    var w = tip.offsetWidth;
    var left;
    if (centered) {
      left = anchorX - w / 2;
    } else {
      left = anchorX + 16;
      if (left + w > cw) left = anchorX - 16 - w;
    }
    left = Math.max(0, Math.min(cw - w, left));
    tip.style.transform = "translate(" + Math.round(left) + "px," + Math.round(anchorY) + "px)";
  }

  function makeLive(container) {
    var live = htmlEl("div", "cviz-sr", container);
    live.setAttribute("aria-live", "polite");
    return live;
  }

  /*
   * Shared keyboard + pointer wiring. `count` marks, `show(i, viaKeyboard)`
   * renders the hover state, `hide()` clears it. Arrow keys step, Home/End jump.
   */
  function wireInteraction(target, count, show, hide, orientation) {
    var active = -1;
    var focused = false;
    var prevKeys = orientation === "vertical" ? ["ArrowUp"] : ["ArrowLeft"];
    var nextKeys = orientation === "vertical" ? ["ArrowDown"] : ["ArrowRight"];
    if (orientation === "both") {
      prevKeys = ["ArrowLeft", "ArrowUp"];
      nextKeys = ["ArrowRight", "ArrowDown"];
    }
    function set(i, viaKeyboard) {
      if (i < 0 || i >= count) return;
      active = i;
      show(i, viaKeyboard);
    }
    target.addEventListener("focus", function () {
      focused = true;
      set(active >= 0 ? active : count - 1, true);
    });
    target.addEventListener("blur", function () {
      focused = false;
      hide();
    });
    target.addEventListener("keydown", function (e) {
      var i = active < 0 ? count - 1 : active;
      if (prevKeys.indexOf(e.key) >= 0) i = Math.max(0, i - 1);
      else if (nextKeys.indexOf(e.key) >= 0) i = Math.min(count - 1, i + 1);
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = count - 1;
      else if (e.key === "Escape") { hide(); return; }
      else return;
      e.preventDefault();
      set(i, true);
    });
    return {
      pointer: function (i) {
        if (i === null || i < 0) {
          if (!focused) hide();
          return;
        }
        set(i, false);
      },
      leave: function () {
        if (focused && active >= 0) show(active, true);
        else hide();
      }
    };
  }

  function localPoint(svg, evt) {
    var r = svg.getBoundingClientRect();
    return { x: evt.clientX - r.left, y: evt.clientY - r.top };
  }

  /* --------------------------------------------------------------- legend */

  function legend(container, items, below) {
    var ul = htmlEl("ul", "cviz-legend" + (below ? " cviz-legend--below" : ""), container);
    items.forEach(function (item) {
      var li = htmlEl("li", null, ul);
      var key = htmlEl("span", "cviz-key cviz-key--" + (item.kind || "rect"), li);
      key.style.background = item.color;
      if (item.status && STATUS_ICONS[item.status]) {
        var ic = icon(STATUS_ICONS[item.status]);
        ic.style.color = item.statusColor;
        li.appendChild(ic);
      }
      htmlEl("span", null, li, item.label);
      if (item.status && STATUS_NAMES[item.status]) {
        htmlEl("span", "cviz-sr", li, " (" + STATUS_NAMES[item.status] + ")");
      }
    });
    return ul;
  }

  /* ----------------------------------------------------------- timeseries */

  function seriesSegments(values) {
    var segs = [];
    var cur = null;
    values.forEach(function (v, i) {
      if (isNum(v)) {
        if (!cur) { cur = []; segs.push(cur); }
        cur.push(i);
      } else {
        cur = null;
      }
    });
    return segs;
  }

  function lastIndex(values) {
    for (var i = values.length - 1; i >= 0; i--) if (isNum(values[i])) return i;
    return -1;
  }

  function chooseTimeTicks(buckets, bucket, pxPerIndex, tokens) {
    var walls = buckets.map(parseWall);
    var n = buckets.length;
    var labels = buckets.map(function (b) { return formatTime(b, bucket, "tick"); });
    var maxW = 0;
    labels.forEach(function (l) { maxW = Math.max(maxW, textWidth(l, 12, 400, tokens.font)); });
    var need = maxW + 16;
    var steps = bucket === "hour" ? [1, 2, 3, 4, 6, 8, 12, 24] : [1, 2, 3, 7, 14, 28];
    var chosen = steps[steps.length - 1];
    for (var s = 0; s < steps.length; s++) {
      if (pxPerIndex * steps[s] >= need) { chosen = steps[s]; break; }
    }
    var idx = [];
    for (var i = 0; i < n; i++) {
      var ok;
      if (bucket === "hour" && walls[i]) ok = walls[i].h % chosen === 0 && walls[i].mi === 0;
      else ok = (n - 1 - i) % chosen === 0;
      if (ok) idx.push(i);
    }
    if (!idx.length && n) idx.push(n - 1);
    return { indices: idx, labels: labels };
  }

  function renderTimeseries(container, chart, opts) {
    var tokens = opts.tokens;
    var W = Math.floor(container.clientWidth);
    if (W < 40) return;
    var unit = chart.unit;
    var buckets = chart.buckets || [];
    var n = buckets.length;
    var series = (chart.series || []).slice(0, 3);
    var mark = chart.mark === "area" || chart.mark === "column" ? chart.mark : "line";
    var colors = series.map(function (_, i) { return tokens.series[i]; });

    if (series.length >= 2) {
      legend(container, series.map(function (s, i) {
        return { label: s.label, color: colors[i], kind: mark === "line" ? "line" : "rect" };
      }));
    }

    var wrap = htmlEl("div", "cviz", container);
    var narrow = W < 480;
    var plotH = narrow ? 168 : 200;

    var all = [];
    series.forEach(function (s) { (s.values || []).forEach(function (v) { if (isNum(v)) all.push(v); }); });
    var lo = Math.min(0, Math.min.apply(null, all.length ? all : [0]));
    var hi = Math.max(0, Math.max.apply(null, all.length ? all : [0]));
    var integer = unit === "count" || unit === "inr";
    var scale = niceTicks(lo, hi, narrow ? 4 : 5, integer);
    var fmtAxis = axisFormatter(unit, scale);
    var tickText = scale.ticks.map(fmtAxis);
    var yLabelW = 0;
    tickText.forEach(function (t) { yLabelW = Math.max(yLabelW, textWidth(t, 12, 400, tokens.font)); });

    var single = series.length === 1;
    var mT = mark === "column" && single ? 24 : 12;
    var mB = 28;
    var mL = Math.ceil(yLabelW) + 12;
    var y = function (v) { return mT + plotH * (1 - (v - scale.min) / (scale.max - scale.min)); };
    var yZero = y(Math.max(scale.min, Math.min(0, scale.max)));

    // End labels (lines/areas): value at each series' last point, unless they collide.
    var ends = [];
    if (mark !== "column") {
      series.forEach(function (s, si) {
        var li = lastIndex(s.values || []);
        if (li >= 0) {
          var text = format(s.values[li], unit, "tile");
          ends.push({ si: si, i: li, y: y(s.values[li]), text: text, w: textWidth(text, 12, 600, tokens.font) });
        }
      });
      var sorted = ends.slice().sort(function (a, b) { return a.y - b.y; });
      for (var k = 1; k < sorted.length; k++) {
        if (sorted[k].y - sorted[k - 1].y < 16) { ends = []; break; }
      }
    }
    var endW = 0;
    ends.forEach(function (e) { endW = Math.max(endW, e.w); });
    var mR = ends.length ? Math.ceil(endW) + 16 : (mark === "column" ? 4 : 8);
    // Labels must fit; on very narrow plots drop them (the tooltip and table keep the values).
    if (W - mL - mR < 120 && ends.length) { ends = []; mR = 8; }
    var pw = Math.max(20, W - mL - mR);
    var H = mT + plotH + mB;

    var band = n ? pw / n : pw;
    var x = mark === "column"
      ? function (i) { return mL + band * (i + 0.5); }
      : function (i) { return n <= 1 ? mL + pw / 2 : mL + (pw * i) / (n - 1); };

    var svg = svgEl("svg", {
      width: W, height: H, viewBox: "0 0 " + W + " " + H,
      class: "cviz-focusable", tabindex: 0, role: "img"
    }, wrap);
    svg.style.touchAction = "pan-y";
    var title = chart.title || "Chart";
    var rangeText = n ? formatTime(buckets[0], chart.bucket, "full") + " to " + formatTime(buckets[n - 1], chart.bucket, "full") : "";
    svg.setAttribute("aria-label", title + ". " + (mark === "column" ? "Column" : mark === "area" ? "Area" : "Line") +
      " chart, " + series.map(function (s) { return s.label; }).join(", ") + ", " + rangeText +
      ". Use the arrow keys to read values, or open the table view.");

    // Gridlines (solid hairlines) and y ticks.
    var gGrid = svgEl("g", { class: "cviz-axis" }, svg);
    scale.ticks.forEach(function (t, i) {
      var yy = crisp(y(t));
      svgEl("line", {
        x1: mL, x2: W - mR, y1: yy, y2: yy,
        stroke: t === 0 ? tokens.baseline : tokens.grid, "stroke-width": 1,
        "shape-rendering": "crispEdges"
      }, gGrid);
      var label = svgEl("text", {
        x: mL - 8, y: y(t), "text-anchor": "end", "dominant-baseline": "central",
        fill: tokens.axisText, "font-size": 12, class: "cviz-tick"
      }, gGrid);
      label.textContent = tickText[i];
    });
    if (scale.min > 0 || scale.max < 0) {
      var yb = crisp(mT + plotH);
      svgEl("line", { x1: mL, x2: W - mR, y1: yb, y2: yb, stroke: tokens.baseline, "stroke-width": 1, "shape-rendering": "crispEdges" }, gGrid);
    }

    // X ticks.
    var pxPerIndex = mark === "column" ? band : (n > 1 ? pw / (n - 1) : pw);
    var xt = chooseTimeTicks(buckets, chart.bucket, pxPerIndex, tokens);
    xt.indices.forEach(function (i) {
      var text = xt.labels[i];
      var w = textWidth(text, 12, 400, tokens.font);
      var cx = x(i);
      var anchor = "middle";
      if (cx - w / 2 < 0) { anchor = "start"; cx = Math.max(0, cx - 4); }
      else if (cx + w / 2 > W) { anchor = "end"; cx = W; }
      var tl = svgEl("text", {
        x: cx, y: mT + plotH + 18, "text-anchor": anchor,
        fill: tokens.axisText, "font-size": 12, class: "cviz-tick"
      }, gGrid);
      tl.textContent = text;
    });

    // Hover wash (columns) sits behind the marks.
    var wash = null;
    if (mark === "column") {
      wash = svgEl("rect", { x: 0, y: mT, width: band, height: plotH, fill: tokens.hoverWash, visibility: "hidden" }, svg);
    }

    var gMarks = svgEl("g", { class: "cviz-marks" }, svg);
    var colRects = [];
    if (mark === "column") {
      var m = series.length;
      var avail = band * (m > 1 ? 0.8 : 0.66);
      var bw = Math.max(1, Math.min(24, (avail - 2 * (m - 1)) / m));
      var groupW = m * bw + 2 * (m - 1);
      series.forEach(function (s, si) {
        (s.values || []).forEach(function (v, i) {
          if (!isNum(v) || v === 0) return;
          var bx = x(i) - groupW / 2 + si * (bw + 2);
          var p = svgEl("path", { d: columnPath(bx, yZero, y(v), bw, 4), fill: colors[si] }, gMarks);
          colRects.push({ el: p, i: i });
        });
      });
      // Selective label: the extreme (max) of a single series, on its cap.
      if (single) {
        var vals = series[0].values || [];
        var mi = -1;
        vals.forEach(function (v, i) { if (isNum(v) && v > 0 && (mi < 0 || v > vals[mi])) mi = i; });
        if (mi >= 0) {
          var capText = format(vals[mi], unit, "tile");
          var cw = textWidth(capText, 12, 600, tokens.font);
          var cx2 = Math.max(cw / 2, Math.min(W - cw / 2, x(mi)));
          var cap = svgEl("text", {
            x: cx2, y: y(vals[mi]) - 8, "text-anchor": "middle",
            fill: tokens.textPrimary, "font-size": 12, "font-weight": 600, class: "cviz-tick"
          }, gMarks);
          cap.textContent = capText;
        }
      }
    } else {
      series.forEach(function (s, si) {
        var values = s.values || [];
        seriesSegments(values).forEach(function (seg) {
          if (seg.length === 1) {
            // An isolated point between gaps: draw it as a marker so it isn't lost.
            svgEl("circle", { cx: x(seg[0]), cy: y(values[seg[0]]), r: 5, fill: colors[si], stroke: tokens.surface, "stroke-width": 2 }, gMarks);
            return;
          }
          var d = seg.map(function (i, k) { return (k ? "L" : "M") + x(i).toFixed(2) + "," + y(values[i]).toFixed(2); }).join("");
          if (mark === "area") {
            var area = d + "L" + x(seg[seg.length - 1]).toFixed(2) + "," + yZero + "L" + x(seg[0]).toFixed(2) + "," + yZero + "Z";
            svgEl("path", { d: area, fill: colors[si], "fill-opacity": 0.1, stroke: "none" }, gMarks);
          }
          svgEl("path", {
            d: d, fill: "none", stroke: colors[si], "stroke-width": 2,
            "stroke-linejoin": "round", "stroke-linecap": "round"
          }, gMarks);
        });
      });
      // End markers + end labels.
      series.forEach(function (s, si) {
        var li = lastIndex(s.values || []);
        if (li < 0) return;
        svgEl("circle", { cx: x(li), cy: y(s.values[li]), r: 5, fill: colors[si], stroke: tokens.surface, "stroke-width": 2 }, gMarks);
      });
      ends.forEach(function (e) {
        var t = svgEl("text", {
          x: x(e.i) + 10, y: e.y, "dominant-baseline": "central",
          fill: tokens.textPrimary, "font-size": 12, "font-weight": 600, class: "cviz-tick"
        }, gMarks);
        t.textContent = e.text;
      });
    }

    // Hover layer: crosshair + per-series markers (lines/areas).
    var gHover = svgEl("g", { visibility: "hidden", "pointer-events": "none" }, svg);
    var cross = null;
    var dots = [];
    if (mark !== "column") {
      cross = svgEl("line", { y1: mT, y2: mT + plotH, stroke: tokens.axisText, "stroke-width": 1, "shape-rendering": "crispEdges" }, gHover);
      series.forEach(function (s, si) {
        dots.push(svgEl("circle", { r: 5, fill: colors[si], stroke: tokens.surface, "stroke-width": 2 }, gHover));
      });
    }

    var tip = makeTooltip(wrap);
    var live = makeLive(wrap);

    function show(i, viaKeyboard) {
      var cx = x(i);
      if (mark === "column") {
        wash.setAttribute("x", mL + band * i);
        wash.setAttribute("visibility", "visible");
      } else {
        cross.setAttribute("x1", crisp(cx));
        cross.setAttribute("x2", crisp(cx));
        series.forEach(function (s, si) {
          var v = (s.values || [])[i];
          if (isNum(v)) {
            dots[si].setAttribute("cx", cx);
            dots[si].setAttribute("cy", y(v));
            dots[si].setAttribute("visibility", "visible");
          } else {
            dots[si].setAttribute("visibility", "hidden");
          }
        });
        gHover.setAttribute("visibility", "visible");
      }
      var head = formatTime(buckets[i], chart.bucket, "full");
      var rows = series.map(function (s, si) {
        return { color: colors[si], value: format((s.values || [])[i], unit, "full"), label: s.label };
      });
      fillTooltip(tip, head, rows);
      placeTooltip(tip, wrap, cx, mT);
      if (viaKeyboard) {
        live.textContent = head + ": " + rows.map(function (r) { return r.label + " " + r.value; }).join("; ");
      }
    }

    function hide() {
      gHover.setAttribute("visibility", "hidden");
      if (wash) wash.setAttribute("visibility", "hidden");
      tip.hidden = true;
    }

    if (!n) return;
    var ctl = wireInteraction(svg, n, show, hide, "both");
    svg.addEventListener("pointermove", function (e) {
      var p = localPoint(svg, e);
      if (p.x < mL - 8 || p.x > W - mR + 8 || p.y < 0 || p.y > mT + plotH + 4) { ctl.pointer(null); return; }
      var i;
      if (mark === "column") i = Math.floor((p.x - mL) / band);
      else i = n <= 1 ? 0 : Math.round(((p.x - mL) / pw) * (n - 1));
      ctl.pointer(Math.max(0, Math.min(n - 1, i)));
    });
    svg.addEventListener("pointerleave", function () { ctl.leave(); });
  }

  /* --------------------------------------------------------------- ranked */

  function renderRanked(container, chart, opts) {
    var tokens = opts.tokens;
    var W = Math.floor(container.clientWidth);
    if (W < 40) return;
    var unit = chart.unit;
    var items = (chart.items || []).filter(function (it) { return it && isNum(it.value); });
    var n = items.length;
    var wrap = htmlEl("div", "cviz", container);
    var font = tokens.font;

    var stacked = W < 420; // phones: label above its bar
    var barH = 16;
    var rowH = stacked ? 44 : 32;
    var valueTexts = items.map(function (it) { return format(it.value, unit, "tile"); });
    var valueW = 0;
    valueTexts.forEach(function (t) { valueW = Math.max(valueW, textWidth(t, 12, 600, font)); });
    var labelW = 0;
    items.forEach(function (it) { labelW = Math.max(labelW, textWidth(it.label, 14, 400, font)); });
    var labelCol = stacked ? 0 : Math.min(Math.ceil(labelW) + 16, Math.floor(W * 0.38));
    var x0 = labelCol;
    var barMax = Math.max(24, W - x0 - Math.ceil(valueW) - 8);
    var maxV = 0;
    items.forEach(function (it) { maxV = Math.max(maxV, it.value); });
    if (!(maxV > 0)) maxV = 1;
    var H = n * rowH;

    var svg = svgEl("svg", {
      width: W, height: H, viewBox: "0 0 " + W + " " + H,
      class: "cviz-focusable", tabindex: 0, role: "img"
    }, wrap);
    svg.style.touchAction = "pan-y";
    svg.setAttribute("aria-label", (chart.title || "Chart") + ". Bar chart ranking " + n + " items, largest " +
      (n ? items[0].label + " " + format(items[0].value, unit, "full") : "none") +
      ". Use the arrow keys to read values, or open the table view.");

    var washes = [];
    var bars = [];
    items.forEach(function (it, i) {
      var top = i * rowH;
      washes.push(svgEl("rect", { x: 0, y: top, width: W, height: rowH, fill: tokens.hoverWash, visibility: "hidden" }, svg));
      var isOther = /^other$/i.test(String(it.label).trim());
      var fill = isOther ? tokens.deemph : tokens.series[0];
      var barY = stacked ? top + 22 : top + (rowH - barH) / 2;
      var len = Math.max(0, (it.value / maxV) * barMax);
      if (len > 0.5) {
        bars.push(svgEl("path", { d: barPath(x0, x0 + len, barY, barH, 4), fill: fill }, svg));
      } else {
        bars.push(null);
      }
      var labelText = ellipsize(it.label, stacked ? W - Math.ceil(valueW) - 16 : labelCol - 16, 14, 400, font);
      var lab = svgEl("text", {
        x: 0, y: stacked ? top + 10 : top + rowH / 2, "dominant-baseline": "central",
        fill: tokens.textSecondary, "font-size": 14
      }, svg);
      lab.textContent = labelText;
      var val = svgEl("text", {
        x: x0 + len + 8, y: barY + barH / 2, "dominant-baseline": "central",
        fill: tokens.textPrimary, "font-size": 12, "font-weight": 600, class: "cviz-tick"
      }, svg);
      val.textContent = valueTexts[i];
    });
    // Baseline the bars grow from. Stacked (phone) rows put the label above the
    // bar, so the baseline is drawn per bar instead of through the labels.
    if (n && stacked) {
      items.forEach(function (it, i) {
        var by = i * rowH + 22;
        svgEl("line", {
          x1: 0.5, x2: 0.5, y1: by - 2, y2: by + barH + 2,
          stroke: tokens.baseline, "stroke-width": 1, "shape-rendering": "crispEdges"
        }, svg);
      });
    } else if (n) {
      svgEl("line", {
        x1: crisp(x0), x2: crisp(x0), y1: 0, y2: H,
        stroke: tokens.baseline, "stroke-width": 1, "shape-rendering": "crispEdges"
      }, svg);
    }

    var tip = makeTooltip(wrap);
    var live = makeLive(wrap);
    var total = 0;
    items.forEach(function (it) { total += it.value; });

    function show(i, viaKeyboard) {
      washes.forEach(function (w, k) { w.setAttribute("visibility", k === i ? "visible" : "hidden"); });
      bars.forEach(function (b, k) { if (b) b.setAttribute("fill-opacity", k === i ? 0.85 : 1); });
      var it = items[i];
      var share = total > 0 ? " (" + nf(0, 1).format((it.value / total) * 100) + "% of shown)" : "";
      var isOther = /^other$/i.test(String(it.label).trim());
      fillTooltip(tip, null, [{ color: isOther ? tokens.deemph : tokens.series[0], value: format(it.value, unit, "full"), label: it.label }]);
      var len = (it.value / maxV) * barMax;
      placeTooltip(tip, wrap, Math.min(W - 8, x0 + len), i * rowH + rowH);
      if (viaKeyboard) live.textContent = it.label + ": " + format(it.value, unit, "full") + share;
    }
    function hide() {
      washes.forEach(function (w) { w.setAttribute("visibility", "hidden"); });
      bars.forEach(function (b) { if (b) b.setAttribute("fill-opacity", 1); });
      tip.hidden = true;
    }
    if (!n) return;
    var ctl = wireInteraction(svg, n, show, hide, "vertical");
    svg.addEventListener("pointermove", function (e) {
      var p = localPoint(svg, e);
      var i = Math.floor(p.y / rowH);
      ctl.pointer(i >= 0 && i < n ? i : null);
    });
    svg.addEventListener("pointerleave", function () { ctl.leave(); });
  }

  /* ------------------------------------------------------------ segmented */

  function segmentColors(items, tokens) {
    var slot = 0;
    return items.map(function (it) {
      if (it.status && tokens.status[it.status]) return tokens.status[it.status];
      if (/^other$/i.test(String(it.label).trim())) return tokens.deemph;
      // Never generate hues: past the three validated slots, the tail goes gray.
      var c = slot < tokens.series.length ? tokens.series[slot] : tokens.deemph;
      slot++;
      return c;
    });
  }

  function shareText(value, total) {
    if (!(total > 0)) return DASH;
    var pct = (value / total) * 100;
    if (pct > 0 && pct < 1) return "<1%";
    return Math.round(pct) + "%";
  }

  function renderSegmented(container, chart, opts) {
    var tokens = opts.tokens;
    var W = Math.floor(container.clientWidth);
    if (W < 40) return;
    var unit = chart.unit || "count";
    var items = (chart.items || []).filter(function (it) { return it && isNum(it.value) && it.value >= 0; });
    var total = 0;
    items.forEach(function (it) { total += it.value; });
    var colors = segmentColors(items, tokens);
    var font = tokens.font;

    var head = htmlEl("div", "cviz-total", container);
    htmlEl("strong", null, head, format(total, unit, "tile"));
    htmlEl("span", null, head, "total");

    var wrap = htmlEl("div", "cviz", container);
    var H = 28;
    var visible = [];
    items.forEach(function (it, i) { if (it.value > 0) visible.push(i); });
    var gaps = Math.max(0, visible.length - 1) * 2;
    var avail = W - gaps;
    // Proportional widths, with a 2px floor so a tiny non-zero part stays visible.
    var widths = visible.map(function (i) { return Math.max(2, (items[i].value / total) * avail); });
    var sumW = widths.reduce(function (a, b) { return a + b; }, 0);
    if (sumW > avail) {
      var scaleDown = avail / sumW;
      widths = widths.map(function (w) { return w * scaleDown; });
    }

    var svg = svgEl("svg", {
      width: W, height: H, viewBox: "0 0 " + W + " " + H,
      class: "cviz-focusable", tabindex: 0, role: "img"
    }, wrap);
    svg.style.touchAction = "pan-y";
    svg.setAttribute("aria-label", (chart.title || "Chart") + ". " + items.map(function (it) {
      return it.label + " " + format(it.value, unit, "full") + " (" + shareText(it.value, total) + ")" +
        (it.status && STATUS_NAMES[it.status] ? ", " + STATUS_NAMES[it.status] : "");
    }).join("; ") + ".");

    var blocks = [];
    var cursor = 0;
    visible.forEach(function (i, k) {
      var w = widths[k];
      var rect = svgEl("rect", { x: cursor, y: 0, width: w, height: H, rx: Math.min(4, w / 2), ry: 4, fill: colors[i] }, svg);
      var label = shareText(items[i].value, total);
      var lw = textWidth(label, 12, 600, font);
      if (lw + 16 <= w) {
        var t = svgEl("text", {
          x: cursor + 8, y: H / 2, "dominant-baseline": "central",
          fill: labelOnFill(colors[i], tokens), "font-size": 12, "font-weight": 600, class: "cviz-tick",
          "pointer-events": "none"
        }, svg);
        t.textContent = label;
      }
      blocks.push({ i: i, x: cursor, w: w, rect: rect });
      cursor += w + 2;
    });
    // A focus/hover outline drawn in the text colour around the active block.
    var ring = svgEl("rect", { fill: "none", stroke: tokens.textPrimary, "stroke-width": 2, rx: 4, ry: 4, visibility: "hidden", "pointer-events": "none" }, svg);

    legend(container, items.map(function (it, i) {
      return {
        label: it.label, color: colors[i], kind: "rect",
        status: it.status && it.status !== "neutral" ? it.status : null,
        statusColor: it.status ? tokens.status[it.status] : null
      };
    }), true);

    var tip = makeTooltip(wrap);
    var live = makeLive(wrap);

    function show(k, viaKeyboard) {
      var b = blocks[k];
      var it = items[b.i];
      ring.setAttribute("x", b.x - 1);
      ring.setAttribute("y", -1);
      ring.setAttribute("width", b.w + 2);
      ring.setAttribute("height", H + 2);
      ring.setAttribute("visibility", "visible");
      var statusInfo = it.status && STATUS_NAMES[it.status]
        ? { status: it.status, color: tokens.status[it.status], label: STATUS_NAMES[it.status] }
        : null;
      fillTooltip(tip, null, [
        { color: colors[b.i], value: format(it.value, unit, "full"), label: it.label },
        { color: "transparent", value: shareText(it.value, total), label: "of total" }
      ], statusInfo);
      placeTooltip(tip, wrap, b.x + b.w / 2, H + 8, true);
      if (viaKeyboard) {
        live.textContent = it.label + ": " + format(it.value, unit, "full") + ", " + shareText(it.value, total) +
          " of total" + (statusInfo ? ", " + statusInfo.label : "");
      }
    }
    function hide() {
      ring.setAttribute("visibility", "hidden");
      tip.hidden = true;
    }
    if (!blocks.length) return;
    var ctl = wireInteraction(svg, blocks.length, show, hide, "both");
    svg.addEventListener("pointermove", function (e) {
      var p = localPoint(svg, e);
      var found = null;
      for (var k = 0; k < blocks.length; k++) {
        // Hit area includes the 2px gap after the block.
        if (p.x >= blocks[k].x - 1 && p.x <= blocks[k].x + blocks[k].w + 1) { found = k; break; }
      }
      ctl.pointer(found);
    });
    svg.addEventListener("pointerleave", function () { ctl.leave(); });
  }

  /* ------------------------------------------------------------ sparkline */

  function sparkline(container, values, opts) {
    var tokens = opts.tokens;
    clear(container);
    var W = Math.floor(container.clientWidth);
    var H = opts.height || 32;
    if (W < 24 || !values || !values.length) return;
    var nums = values.filter(isNum);
    if (!nums.length) return;
    var pad = 6; // room for the 8px end dot + its 2px ring
    var lo = Math.min.apply(null, nums);
    var hi = Math.max.apply(null, nums);
    var n = values.length;
    var x = function (i) { return n <= 1 ? W / 2 : pad + ((W - 2 * pad) * i) / (n - 1); };
    var y = function (v) { return hi === lo ? H / 2 : pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo)); };
    var svg = svgEl("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, "aria-hidden": "true", focusable: "false" }, container);
    seriesSegments(values).forEach(function (seg) {
      if (seg.length < 2) return;
      var d = seg.map(function (i, k) { return (k ? "L" : "M") + x(i).toFixed(2) + "," + y(values[i]).toFixed(2); }).join("");
      svgEl("path", { d: d, fill: "none", stroke: tokens.deemph, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    });
    var li = lastIndex(values);
    if (li >= 0) {
      svgEl("circle", { cx: x(li), cy: y(values[li]), r: 5, fill: tokens.series[0], stroke: opts.surface || tokens.surface, "stroke-width": 2 }, svg);
    }
  }

  /* ---------------------------------------------------------------- table */

  function table(chart) {
    var t = document.createElement("table");
    t.className = "insights-table";
    htmlEl("caption", null, t, chart.title || "Chart data");
    var thead = htmlEl("thead", null, t);
    var hr = htmlEl("tr", null, thead);
    var tbody = htmlEl("tbody", null, t);
    function th(row, text, num) {
      var c = htmlEl("th", num ? "is-num" : null, row, text);
      c.setAttribute("scope", "col");
      return c;
    }
    function rowHead(row, text) {
      var c = htmlEl("th", null, row, text);
      c.setAttribute("scope", "row");
      return c;
    }
    if (chart.type === "timeseries") {
      var series = chart.series || [];
      th(hr, chart.bucket === "hour" ? "Time" : "Date");
      series.forEach(function (s) { th(hr, s.label, true); });
      (chart.buckets || []).forEach(function (b, i) {
        var tr = htmlEl("tr", null, tbody);
        rowHead(tr, formatTime(b, chart.bucket, "full"));
        series.forEach(function (s) { htmlEl("td", "is-num", tr, format((s.values || [])[i], chart.unit, "full")); });
      });
    } else if (chart.type === "ranked") {
      th(hr, "Item");
      th(hr, "Value", true);
      (chart.items || []).forEach(function (it) {
        var tr = htmlEl("tr", null, tbody);
        rowHead(tr, it.label);
        htmlEl("td", "is-num", tr, format(it.value, chart.unit, "full"));
      });
    } else if (chart.type === "segmented") {
      var items = chart.items || [];
      var total = 0;
      items.forEach(function (it) { if (isNum(it.value)) total += it.value; });
      var hasStatus = items.some(function (it) { return !!it.status; });
      th(hr, "Item");
      th(hr, "Value", true);
      th(hr, "Share", true);
      if (hasStatus) th(hr, "Status");
      items.forEach(function (it) {
        var tr = htmlEl("tr", null, tbody);
        rowHead(tr, it.label);
        htmlEl("td", "is-num", tr, format(it.value, chart.unit || "count", "full"));
        htmlEl("td", "is-num", tr, isNum(it.value) ? shareText(it.value, total) : DASH);
        if (hasStatus) {
          var td = htmlEl("td", null, tr);
          if (it.status && STATUS_NAMES[it.status]) {
            var wrap = htmlEl("span", "insights-table__status", td);
            var ic = icon(STATUS_ICONS[it.status], "is-" + it.status);
            ic.style.color = "var(--viz-" + it.status + ")";
            wrap.appendChild(ic);
            htmlEl("span", null, wrap, STATUS_NAMES[it.status]);
          } else {
            td.textContent = DASH;
          }
        }
      });
    }
    return t;
  }

  /* ------------------------------------------------------------- dispatch */

  function isEmpty(chart) {
    if (!chart) return true;
    if (chart.type === "timeseries") {
      if (!chart.buckets || !chart.buckets.length) return true;
      return !(chart.series || []).some(function (s) { return (s.values || []).some(isNum); });
    }
    if (chart.type === "ranked") {
      return !(chart.items || []).some(function (it) { return it && isNum(it.value); });
    }
    if (chart.type === "segmented") {
      return !(chart.items || []).some(function (it) { return it && isNum(it.value) && it.value > 0; });
    }
    return true;
  }

  function render(container, chart, opts) {
    opts = opts || {};
    clear(container);
    if (!opts.tokens) opts.tokens = readTokens(container);
    if (chart.type === "timeseries") renderTimeseries(container, chart, opts);
    else if (chart.type === "ranked") renderRanked(container, chart, opts);
    else if (chart.type === "segmented") renderSegmented(container, chart, opts);
  }

  global.CarbonViz = {
    render: render,
    sparkline: sparkline,
    table: table,
    isEmpty: isEmpty,
    format: format,
    formatTime: formatTime,
    readTokens: readTokens,
    icon: icon,
    statusNames: STATUS_NAMES,
    statusIcons: STATUS_ICONS
  };
})(window);

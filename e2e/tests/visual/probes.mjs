// In-page probes for the motion and accessibility budgets (UI overhaul plan
// §2.4, §7.5 WS-I, §7.6). OWNER: WS-I. Each export runs in the browser via
// page.evaluate (self-contained: no closures over Node values, no eval) and returns plain data, so a
// failing assertion prints exactly which element broke the budget.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const AXE_PATH = require.resolve("axe-core/axe.min.js");

/**
 * Elements with a running-capable transition on a layout or paint-heavy
 * property (plan §2.4: only transform and opacity animate; colour ≤110 ms).
 * Also CSS animations whose keyframes touch those properties.
 */
export function probeLayoutMotion() {
  const describe = (el) => {
    const part = (node) => {
      let label = node.tagName.toLowerCase();
      if (node.id) label += "#" + node.id;
      const classes = [...(node.classList || [])].slice(0, 2);
      if (classes.length) label += "." + classes.join(".");
      return label;
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3; node = node.parentElement) parts.unshift(part(node));
    return parts.join(" > ");
  };
  const BANNED = /^(all|width|height|inline-size|block-size|min-width|min-height|max-width|max-height|min-inline-size|max-inline-size|min-block-size|max-block-size|margin.*|padding.*|inset.*|top|left|right|bottom|flex|flex-basis|grid-template.*|grid-row|grid-column|box-shadow|background-position|filter)$/;
  const seconds = (value) => {
    const text = String(value).trim();
    return text.endsWith("ms") ? parseFloat(text) / 1000 : parseFloat(text) || 0;
  };
  const transitions = [];
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (style.transitionProperty === "none" || style.transitionDuration === "0s") continue;
    const props = style.transitionProperty.split(",").map((item) => item.trim());
    const durations = style.transitionDuration.split(",").map(seconds);
    props.forEach((prop, index) => {
      const duration = durations[index % durations.length];
      if (duration > 0 && BANNED.test(prop)) transitions.push(`${describe(el)} transition ${prop} ${duration * 1000}ms`);
    });
  }
  const keyframeProblems = [];
  for (const animation of document.getAnimations()) {
    const keyframes = animation.effect?.getKeyframes?.() || [];
    const props = new Set(keyframes.flatMap((frame) => Object.keys(frame)).filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key)));
    const bad = [...props].map((key) => key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())).filter((key) => BANNED.test(key));
    if (bad.length) keyframeProblems.push(`${describe(animation.effect?.target || document.body)} animation ${animation.animationName || animation.id || "(waapi)"} animates ${bad.join(", ")}`);
  }
  return [...new Set([...transitions, ...keyframeProblems])];
}

/** Running animations that never end (iterations = Infinity). */
export function probeInfiniteAnimations() {
  const describe = (el) => {
    const part = (node) => {
      let label = node.tagName.toLowerCase();
      if (node.id) label += "#" + node.id;
      const classes = [...(node.classList || [])].slice(0, 2);
      if (classes.length) label += "." + classes.join(".");
      return label;
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3; node = node.parentElement) parts.unshift(part(node));
    return parts.join(" > ");
  };
  return document
    .getAnimations()
    .filter((animation) => animation.playState === "running" && animation.effect?.getTiming?.().iterations === Infinity)
    .map((animation) => `${describe(animation.effect?.target || document.body)} ${animation.animationName || "(waapi)"}`);
}

/** Init script: records transform transitions and CSS animations as they start. */
export const RECORD_MOTION_INIT = `(() => {
  window.__motionLog = { transitions: [], animations: [] };
  const label = (node) => {
    if (!node || !node.tagName) return "?";
    const classes = typeof node.className === "string" ? node.className.trim().split(" ").filter(Boolean).slice(0, 2) : [];
    return node.tagName.toLowerCase() + (classes.length ? "." + classes.join(".") : "");
  };
  document.addEventListener("transitionstart", (event) => {
    window.__motionLog.transitions.push({ property: event.propertyName, target: label(event.target), duration: event.elapsedTime });
  }, true);
  document.addEventListener("animationstart", (event) => {
    window.__motionLog.animations.push({ name: event.animationName, target: label(event.target) });
  }, true);
})();`;

/** Under reduced motion nothing moves in: no translate transitions, no keyframes with translate. */
export function probeTranslateEntrances() {
  const log = window.__motionLog || { transitions: [], animations: [] };
  const moved = log.transitions.filter((item) => ["transform", "translate"].includes(item.property)).map((item) => `transition ${item.property} on ${item.target}`);
  const translating = new Set();
  const visit = (rules) => {
    for (const rule of rules || []) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        const text = rule.cssText;
        if (/translate(?:[XYZ3d]*)\(\s*-?(?:[1-9]|0?\.\d*[1-9])/.test(text) || /translate:\s*-?(?:[1-9]|0?\.\d*[1-9])/.test(text)) translating.add(rule.name);
      } else if (rule.cssRules) {
        visit(rule.cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      // cross-origin sheet (fonts): no keyframes of ours
    }
  }
  const animated = log.animations.filter((item) => translating.has(item.name)).map((item) => `animation ${item.name} on ${item.target}`);
  return [...new Set([...moved, ...animated])];
}

/** Champagne-filled elements visible in the viewport (rules and hairlines excluded). */
export function probeChampagne() {
  const describe = (el) => {
    const part = (node) => {
      let label = node.tagName.toLowerCase();
      if (node.id) label += "#" + node.id;
      const classes = [...(node.classList || [])].slice(0, 2);
      if (classes.length) label += "." + classes.join(".");
      return label;
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3; node = node.parentElement) parts.unshift(part(node));
    return parts.join(" > ");
  };
  const CHAMPAGNE = new Set(["rgb(243, 226, 179)", "rgb(255, 240, 200)", "rgb(230, 210, 156)"]);
  const hits = [];
  for (const el of document.querySelectorAll("body *")) {
    const style = getComputedStyle(el);
    if (!CHAMPAGNE.has(style.backgroundColor) || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 16) continue; // rules, bars, dots
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
    // A champagne child inside a champagne parent is the same element visually.
    if (el.parentElement && CHAMPAGNE.has(getComputedStyle(el.parentElement).backgroundColor)) continue;
    hits.push(`${describe(el)} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
  }
  return hits;
}

/** Distinct corner radii on visible elements: 0 and "pill" are the two allowed values. */
export function probeRadii() {
  const describe = (el) => {
    const part = (node) => {
      let label = node.tagName.toLowerCase();
      if (node.id) label += "#" + node.id;
      const classes = [...(node.classList || [])].slice(0, 2);
      if (classes.length) label += "." + classes.join(".");
      return label;
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3; node = node.parentElement) parts.unshift(part(node));
    return parts.join(" > ");
  };
  const values = new Map();
  for (const el of document.querySelectorAll("body *")) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    // A radius only shows on a box with a background, border or outline-like edge.
    const painted =
      (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") ||
      parseFloat(style.borderTopWidth) > 0 ||
      style.backgroundImage !== "none" ||
      ["IMG", "VIDEO", "CANVAS", "IFRAME"].includes(el.tagName);
    if (!painted) continue;
    for (const corner of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]) {
      const raw = style[corner];
      const px = raw.includes("%") ? (parseFloat(raw) / 100) * Math.min(rect.width, rect.height) : parseFloat(raw) || 0;
      const key = px < 0.5 ? "0" : px >= Math.min(rect.width, rect.height) / 2 - 0.5 || px >= 999 ? "pill" : `${Math.round(px)}px`;
      if (!values.has(key)) values.set(key, describe(el));
    }
  }
  return Object.fromEntries(values);
}

/** The computed font of the page body and its main heading. */
export function probeFonts() {
  const family = (el) => (el ? getComputedStyle(el).fontFamily : "");
  return {
    body: family(document.body),
    heading: family(document.querySelector("h1")),
    plexLoaded: Boolean(document.fonts?.check?.('400 16px "IBM Plex Sans"')),
  };
}

/**
 * WCAG 2.5.8 target size (minimum): interactive targets are at least 24x24
 * CSS px, unless spaced so a 24 px circle on each does not touch another
 * target. Inline links inside a sentence are exempt.
 */
export function probeTargetSize() {
  const describe = (el) => {
    const part = (node) => {
      let label = node.tagName.toLowerCase();
      if (node.id) label += "#" + node.id;
      const classes = [...(node.classList || [])].slice(0, 2);
      if (classes.length) label += "." + classes.join(".");
      return label;
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3; node = node.parentElement) parts.unshift(part(node));
    return parts.join(" > ");
  };
  const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=switch]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=menuitem]",
    "[role=option]",
  ].join(",");
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    if (el.closest("[aria-hidden=true], [inert]")) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2; // visually hidden inputs (Carbon) are not the target; their label is
  };
  const inlineInText = (el) => {
    if (el.tagName !== "A" || getComputedStyle(el).display !== "inline") return false;
    const parent = el.parentElement;
    if (!parent) return false;
    return [...parent.childNodes].some((node) => node !== el && node.nodeType === 3 && node.textContent.trim().length > 2);
  };
  const targets = [...document.querySelectorAll(SELECTOR)].filter(visible).filter((el) => !el.disabled);
  // Nested targets (a button inside a link) count once: keep the outermost.
  const outer = targets.filter((el) => !targets.some((other) => other !== el && other.contains(el)));
  const boxes = outer.map((el) => ({ el, rect: el.getBoundingClientRect() }));
  const small = boxes.filter(({ el, rect }) => (rect.width < 23.5 || rect.height < 23.5) && !inlineInText(el));
  const centre = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  const circleHitsRect = (c, rect) => {
    const dx = Math.max(rect.left - c.x, 0, c.x - rect.right);
    const dy = Math.max(rect.top - c.y, 0, c.y - rect.bottom);
    return dx * dx + dy * dy < 144;
  };
  const failures = [];
  for (const item of small) {
    const c = centre(item.rect);
    const crowded = boxes.some(({ el, rect }) => {
      if (el === item.el) return false;
      if (circleHitsRect(c, rect)) return true;
      if (small.some((other) => other.el === el)) {
        const o = centre(rect);
        return Math.hypot(o.x - c.x, o.y - c.y) < 24;
      }
      return false;
    });
    if (crowded) {
      const name = (item.el.getAttribute("aria-label") || item.el.innerText || item.el.getAttribute("title") || "").trim().slice(0, 30);
      failures.push(`${describe(item.el)} "${name}" ${Math.round(item.rect.width)}x${Math.round(item.rect.height)}`);
    }
  }
  return failures;
}

/** Page wider than the viewport (sideways scroll), with the widest offenders. */
export function probeHorizontalOverflow() {
  const describe = (el) => {
    const part = (node) => {
      let label = node.tagName.toLowerCase();
      if (node.id) label += "#" + node.id;
      const classes = [...(node.classList || [])].slice(0, 2);
      if (classes.length) label += "." + classes.join(".");
      return label;
    };
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3; node = node.parentElement) parts.unshift(part(node));
    return parts.join(" > ");
  };
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  if (overflow <= 1) return { overflow: 0, offenders: [] };
  const offenders = [...document.querySelectorAll("body *")]
    .map((el) => ({ el, right: el.getBoundingClientRect().right }))
    .filter((item) => item.right > window.innerWidth + 1)
    .sort((a, b) => b.right - a.right)
    .slice(0, 5)
    .map((item) => `${describe(item.el)} right=${Math.round(item.right)}`);
  return { overflow, offenders };
}


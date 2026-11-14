#!/usr/bin/env node
// "Syed Carbon" token build (plan §7.1). No dependencies beyond what is
// already installed: reads @carbon/themes, @carbon/type, @carbon/motion and
// @carbon/colors from node_modules and writes
//
//   src/styles/tokens.css   [data-theme="white"|"g10"|"g100"] scopes setting
//                           every --cds-* colour token, the brand tokens and
//                           the site foundations (--sc-*: type, spacing,
//                           motion, grid); committed, imported by the site.
//   src/styles/tokens.json  the same values for the mobile app (theme.ts) later.
//   public/fonts/plex/      IBM Plex Sans 300/400/600 and Plex Mono 400,
//                           latin subset woff2 copied from @ibm/plex-*, with
//                           the SIL OFL licence.
//   ../backend/apps/users/static/admin/css/admin-tokens.css   the same tokens
//                           for the Django admin (dark), plus the Plex files in
//                           ../backend/apps/users/static/admin/fonts/plex/.
//
// HackPath redesign (WS-KIT, PHILOSOPHY §3): every Carbon colour passes
// through the palette law (scripts/palette-law.mjs: black, greys, whites and
// golden white only; hues become the grey of the same luminance), the dark
// set is the new canvas (#000 / #0a0a0a / white-10 hairlines), type is Geist
// + Geist Mono + Handlee, and the radius is shadcn's .625rem. It also writes
//
//   src/styles/theme.css    the shadcn-style tokens (--background, --card,
//                           --accent ...) that tailwind.config.js maps.
//   public/fonts/{geist,geist-mono,handlee}/   Fontsource woff2 + OFL.
//
// Run: npm run tokens          (writes the files)
//      npm run tokens -- --check  (exits 1 when the committed files are stale)
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toLawful } from "./palette-law.mjs";
import { HP, FONT_FACES, FALLBACK_FACES, themeCss, adminThemeCss } from "./hackpath-theme.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const themes = require("@carbon/themes");
const type = require("@carbon/type");
const motion = require("@carbon/motion");
const colors = require("@carbon/colors");

// --------------------------------------------------------------- colour themes

/** Carbon theme objects and the key each component-token table uses for them. */
const THEMES = [
  { id: "white", tokens: themes.white, componentKey: "whiteTheme", dark: false },
  { id: "g10", tokens: themes.g10, componentKey: "g10", dark: false },
  { id: "g100", tokens: themes.g100, componentKey: "g100", dark: true },
];
// Not used on the public site (AI, chat and code-syntax surfaces): left out to keep the file small.
const SKIPPED_PREFIXES = /^(ai|chat|syntax)[A-Z]/;
const COMPONENT_TABLES = ["buttonTokens", "tagTokens", "notificationTokens", "statusTokens"];

const isColour = (value) => typeof value === "string" && /^(#|rgba?\()/.test(value);
const cssName = (name) => themes.formatTokenName(name);

// Palette law on top of Carbon (HackPath redesign). The dark set becomes the
// new canvas; interaction is white (dark) or black (light), focus is golden
// white on dark; every remaining hue is mapped to luminance by toLawful().
const CARBON_OVERRIDES = {
  dark: {
    background: HP.dark.background,
    "background-brand": HP.dark.foreground,
    "layer-01": HP.dark.card,
    "layer-02": HP.dark.cardRaised,
    "layer-03": HP.dark.muted,
    "layer-background-01": HP.dark.background,
    "layer-background-02": HP.dark.card,
    "layer-background-03": HP.dark.cardRaised,
    "layer-hover-01": HP.dark.muted,
    "layer-hover-02": "#1f1f1f",
    "layer-selected-01": "#1f1f1f",
    "layer-accent-01": HP.dark.muted,
    "field-01": HP.dark.card,
    "field-02": HP.dark.cardRaised,
    "field-hover-01": HP.dark.muted,
    "field-hover-02": "#1f1f1f",
    "border-subtle-00": HP.dark.border,
    "border-subtle-01": HP.dark.border,
    "border-subtle-02": HP.dark.borderStrong,
    "border-subtle-03": HP.dark.borderStrong,
    "border-strong-01": "rgba(255, 255, 255, 0.35)",
    "border-tile-01": HP.dark.border,
    "border-interactive": HP.dark.accent,
    "text-primary": HP.dark.foreground,
    "text-secondary": HP.dark.mutedForeground,
    "text-helper": HP.dark.subtleForeground,
    "text-placeholder": HP.dark.placeholder,
    "text-error": HP.dark.foreground,
    "icon-primary": HP.dark.foreground,
    "icon-secondary": HP.dark.mutedForeground,
    "icon-interactive": HP.dark.foreground,
    focus: HP.dark.accent,
    "focus-inset": HP.dark.background,
    "focus-inverse": HP.dark.background,
    interactive: HP.dark.foreground,
    highlight: "rgba(243, 226, 179, 0.14)",
    "link-primary": HP.dark.foreground,
    "link-primary-hover": "#ffffff",
    "link-secondary": HP.dark.mutedForeground,
    "link-visited": HP.dark.mutedForeground,
    "link-inverse": HP.dark.background,
    "button-primary": HP.dark.foreground,
    "button-primary-hover": "#e0e0e0",
    "button-primary-active": "#c6c6c6",
    "button-secondary": "transparent",
    "button-secondary-hover": "rgba(255, 255, 255, 0.08)",
    "button-tertiary": HP.dark.foreground,
    "button-separator": HP.dark.background,
    "skeleton-background": HP.dark.muted,
    "skeleton-element": "#1f1f1f",
    "support-error": HP.dark.foreground,
    "support-success": HP.dark.foreground,
    "support-warning": HP.dark.accent,
    "support-info": HP.dark.mutedForeground,
    "notification-background-error": HP.dark.card,
    "notification-background-info": HP.dark.card,
    "notification-background-success": HP.dark.card,
    "notification-background-warning": HP.dark.card,
  },
  light: {
    interactive: "#161616",
    "border-interactive": "#161616",
    focus: "#161616",
    "link-primary": "#161616",
    "link-primary-hover": "#000000",
    "button-primary": "#161616",
    "button-primary-hover": "#393939",
    "button-primary-active": "#525252",
    "background-brand": "#161616",
    "support-error": "#000000",
    "support-success": "#161616",
    "support-warning": "#393939",
    "support-info": "#525252",
  },
};

function themeColours(theme) {
  const out = {};
  for (const [name, value] of Object.entries(theme.tokens)) {
    if (SKIPPED_PREFIXES.test(name) || !isColour(value)) continue;
    out[cssName(name)] = value;
  }
  for (const table of COMPONENT_TABLES) {
    for (const [name, perTheme] of Object.entries(themes[table] || {})) {
      const value = perTheme?.[theme.componentKey];
      if (isColour(value)) out[cssName(name)] = value;
    }
  }
  Object.assign(out, theme.dark ? CARBON_OVERRIDES.dark : CARBON_OVERRIDES.light);
  return Object.fromEntries(Object.entries(out).map(([name, value]) => [name, toLawful(value)]).sort(([a], [b]) => a.localeCompare(b)));
}

// -------------------------------------------------------------- brand tokens
// Champagne is an accent on dark bands only (featured-tile rule, active-nav
// underline, certificate hairline, hero eyebrow rule; at most one per
// viewport). On light bands the accent is the darker ink, for text and icons
// only (5.96:1 on white). Focus is monochrome. Live/error and success follow
// the Carbon support colours per theme.
// Palette law: no red live dot, no green success. Live is golden white on dark
// (black on light); success is white (black on light); the icon and the word
// carry the meaning. The light-band "ink" is a near-black grey, not a gold.
const BRAND = {
  constants: {
    "brand-champagne": "#f3e2b3",
    "brand-champagne-ink": "#262626",
    // OwlCognito (and any future brand) overrides only these two inputs.
    "brand-accent-on-dark": "var(--brand-champagne)",
    "brand-accent-on-light": "var(--brand-champagne-ink)",
  },
  light: {
    "brand-accent": "var(--brand-accent-on-light)",
    "brand-accent-rule": themes.white.borderStrong01,
    "brand-live": "#000000",
    "brand-success": "#161616",
    "brand-focus": "#161616",
    "brand-band-dark": HP.dark.background,
  },
  dark: {
    "brand-accent": "var(--brand-accent-on-dark)",
    "brand-accent-rule": "var(--brand-accent-on-dark)",
    "brand-live": HP.dark.accent,
    "brand-success": HP.dark.foreground,
    "brand-focus": HP.dark.accent,
    "brand-band-dark": HP.dark.background,
  },
  owlcognito: {
    "brand-accent-on-dark": "#c4b5fd",
    "brand-accent-on-light": "#6d28d9",
  },
};

// -------------------------------------------------------------- foundations

const px = (rem) => parseFloat(rem) * 16;
/** Linear clamp between two viewport widths (px), in rem + vw. */
function fluid(minRem, maxRem, fromPx = 672, toPx = 1312) {
  const min = px(minRem);
  const max = px(maxRem);
  const slope = (max - min) / (toPx - fromPx);
  const intercept = (min - slope * fromPx) / 16;
  return `clamp(${minRem}, ${intercept.toFixed(4)}rem + ${(slope * 100).toFixed(4)}vw, ${maxRem})`;
}

const typeStyle = (style, overrides = {}) => ({
  size: style.fontSize,
  weight: String(style.fontWeight ?? 400),
  "line-height": String(style.lineHeight),
  "letter-spacing": style.letterSpacing ? String(style.letterSpacing) : "0",
  ...overrides,
});

const FOUNDATIONS = {
  font: {
    sans: HP.font.sans,
    mono: HP.font.mono,
    hand: HP.font.hand,
  },
  type: {
    // hero: fluid-display-01 (42 -> 60, Plex Light)
    hero: typeStyle(type.fluidDisplay01, { size: fluid("2.625rem", "3.75rem"), "line-height": "1.17" }),
    // h2: fluid-heading-05 (32 -> 42, Light)
    h2: typeStyle(type.fluidHeading05, { size: fluid("2rem", "2.625rem"), weight: "300", "line-height": "1.19" }),
    "heading-03": typeStyle(type.heading03),
    "heading-02": typeStyle(type.heading02),
    "body-02": typeStyle(type.body02),
    "body-01": typeStyle(type.body01),
    "label-01": typeStyle(type.label01),
    "code-01": typeStyle(type.code01),
    // UI overhaul §2.1 (Console and admin; Plex, sentence case, no negative tracking).
    greeting: { size: "2.625rem", weight: "300", "line-height": "1.19048", "letter-spacing": "0" }, // 42/50
    "page-title": { size: "2rem", weight: "400", "line-height": "1.25", "letter-spacing": "0" }, // 32/40, phone 28/36
    "heading-04": typeStyle(type.heading04, { "line-height": "1.28572" }), // 28/36
    "number-xl": { size: "2.625rem", weight: "300", "line-height": "1.14286", "letter-spacing": "0" }, // 42/48
    "number-m": { size: "1.25rem", weight: "400", "line-height": "1.4", "letter-spacing": "0" }, // 20/28
  },
  // Phone sizes for the Console titles (below md, 672 px).
  "type-phone": {
    "greeting-size": "1.75rem",
    "greeting-line-height": "1.28572",
    "page-title-size": "1.75rem",
    "page-title-line-height": "1.28572",
  },
  spacing: Object.fromEntries(
    Array.from({ length: 13 }, (_unused, index) => {
      const key = String(index + 1).padStart(2, "0");
      return [`spacing-${key}`, themes[`spacing${key}`]];
    })
  ),
  motion: {
    // UI overhaul §2.2: the full Carbon duration/easing scale. Only transform
    // and opacity animate (scripts/check-motion.mjs enforces it).
    "duration-fast-01": "70ms",
    "duration-fast-02": "110ms",
    "duration-moderate-01": "150ms",
    "duration-moderate-02": "240ms",
    "duration-slow-01": "400ms",
    "duration-slow-02": "700ms",
    "ease-standard-productive": motion.easings.standard.productive,
    "ease-standard-expressive": motion.easings.standard.expressive,
    "ease-entrance-productive": motion.easings.entrance.productive,
    "ease-entrance-expressive": motion.easings.entrance.expressive,
    "ease-exit-productive": motion.easings.exit.productive,
    "ease-exit-expressive": motion.easings.exit.expressive,
    "ease-linear": "linear",
    "motion-distance-01": "4px",
    "motion-distance-02": "8px",
    "motion-distance-03": "16px",
    "stagger-step": "40ms",
    "stagger-max": "6",
    "live-period": "2000ms",
    "shimmer-period": "2000ms",
    "skeleton-delay": "300ms",
    "skeleton-min": "250ms",
    // Phase 1 names, kept as aliases until every caller has moved.
    "duration-productive": "110ms",
    "duration-expressive": "240ms",
    "easing-productive": motion.easings.standard.productive,
    "easing-entrance": motion.easings.entrance.expressive,
    "easing-exit": motion.easings.exit.productive,
  },
  // Reduced motion (OS setting or Profile toggle `data-motion="reduce"`):
  // no travel, no stagger, no long animations; short fades of 100 ms or less.
  "motion-reduced": {
    "duration-fast-01": "70ms",
    "duration-fast-02": "100ms",
    "duration-moderate-01": "100ms",
    "duration-moderate-02": "0ms",
    "duration-slow-01": "0ms",
    "duration-slow-02": "0ms",
    "motion-distance-01": "0px",
    "motion-distance-02": "0px",
    "motion-distance-03": "0px",
    "stagger-step": "0ms",
    "duration-productive": "0ms",
    "duration-expressive": "0ms",
  },
  // Carbon 2x grid: 4 / 8 / 16 columns, 32 px gutter, max 1584 px. Band padding 64 / 96 px.
  grid: {
    breakpoints: { sm: 0, md: 672, lg: 1056, xlg: 1312, max: 1584 },
    columns: { sm: 4, md: 8, lg: 16 },
    gutter: "2rem",
    "max-width": "99rem",
    margin: { sm: "1rem", md: "2rem", max: "2.5rem" },
    "band-padding": { sm: "4rem", lg: "6rem" },
    "heading-gap": "3rem",
    "tile-padding": { sm: "1rem", lg: "1.5rem" },
    radius: HP.radius,
  },
};

// ------------------------------------------------------- semantic (--sc-*)
// UI overhaul §2.1: one vocabulary for the site, the Console and the admin.
// Dark is Carbon g100 (the Console, the admin and the site's dark bands);
// light is white/g10 (the site's light bands). :root carries the dark set,
// because the Console and the admin are dark; every [data-theme] scope
// carries its own set so a band always reads its own surface.

/** Surfaces, borders, text, icons and status for one Carbon theme. */
function semanticColours(theme) {
  if (theme.dark) {
    // HackPath canvas (PHILOSOPHY §3.1): black, #0a0a0a cards, white-10 hairlines,
    // the text floor #8a8a8a (AA on black and on #0a0a0a). Status by luminance.
    const d = HP.dark;
    return {
      "sc-surface-page": d.background,
      "sc-surface-01": d.card,
      "sc-surface-02": d.cardRaised,
      "sc-surface-hover-01": d.muted,
      "sc-surface-selected-01": "#1f1f1f",
      "sc-border-subtle": d.border,
      "sc-border-strong": d.borderStrong,
      "sc-text-primary": d.foreground,
      "sc-text-secondary": d.mutedForeground,
      "sc-text-helper": d.subtleForeground,
      "sc-text-placeholder": d.placeholder,
      "sc-text-disabled": "#525252",
      "sc-icon-primary": d.foreground,
      "sc-icon-secondary": d.mutedForeground,
      "sc-status-live": d.accent,
      "sc-status-error": "#ffffff",
      "sc-status-success": d.foreground,
      "sc-status-warning": d.accent,
      "sc-status-info": "#d4d4d4",
      "sc-status-neutral": d.subtleForeground,
      "sc-accent-rule": "var(--sc-accent)",
    };
  }
  const t = theme.tokens;
  return {
    "sc-surface-page": t.background,
    "sc-surface-01": t.layer01,
    "sc-surface-02": t.layer02,
    "sc-surface-hover-01": t.layerHover01,
    "sc-surface-selected-01": t.layerSelected01,
    "sc-border-subtle": t.borderSubtle00,
    "sc-border-strong": t.borderStrong01,
    "sc-text-primary": t.textPrimary,
    "sc-text-secondary": t.textSecondary,
    "sc-text-helper": t.textHelper,
    "sc-text-placeholder": t.textPlaceholder,
    "sc-text-disabled": t.textDisabled,
    "sc-icon-primary": t.iconPrimary,
    "sc-icon-secondary": t.iconSecondary,
    // Status: always an icon and a word next to it, never colour alone.
    // Light bands: status is ink depth, never hue.
    "sc-status-live": "#000000",
    "sc-status-error": "#000000",
    "sc-status-success": "#161616",
    "sc-status-warning": "#393939",
    "sc-status-info": "#525252",
    "sc-status-neutral": colors.gray60,
    "sc-accent-rule": t.borderStrong01,
  };
}

// Theme-independent semantic constants (champagne, shape, elevation).
const SEMANTIC_CONSTANTS = {
  // Champagne: eyebrow rule, active-nav bar, featured-tile rule, the ONE
  // next-best-action button per view, the "you" series, the certificate
  // hairline. Never status, links, focus or glow.
  "sc-accent": "var(--brand-accent-on-dark)",
  "sc-accent-hover": HP.dark.accentStrong,
  "sc-accent-active": HP.dark.accentDeep,
  "sc-accent-on": HP.dark.accentForeground,
  "sc-accent-wash": "rgba(243, 226, 179, 0.08)",
  "sc-accent-ink": "var(--brand-accent-on-light)",
  "sc-accent-rule-width": "2px",
  // Shape (HackPath / shadcn): cards and frames .625rem, controls 8px, a pill.
  "sc-radius-surface": HP.radius,
  "sc-radius-control": "calc(var(--sc-radius-surface) - 2px)",
  "sc-radius-pill": "999px",
  "sc-radius-media": "calc(var(--sc-radius-surface) + 4px)",
  // Elevation comes from layers; this is the only shadow (menus, toasts, popovers, palette).
  "sc-shadow-floating": "0 2px 6px rgba(0, 0, 0, 0.3)",
  "sc-overlay": "rgba(0, 0, 0, 0.6)",
};

const G100 = THEMES.find((theme) => theme.id === "g100");

// ------------------------------------------------------------------ writers

const decls = (entries, indent = "  ") =>
  Object.entries(entries)
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join("\n");

function themeBlock(theme) {
  const brand = theme.dark ? BRAND.dark : BRAND.light;
  return `[data-theme="${theme.id}"] {
  color-scheme: ${theme.dark ? "dark" : "light"};
${decls(Object.fromEntries(Object.entries(themeColours(theme)).map(([name, value]) => [`cds-${name}`, value])))}
${decls(brand)}
${decls(semanticColours(theme))}
}`;
}

/** Every theme-independent --sc-* foundation, in emission order. */
function foundationVars() {
  const { font, type: styles, spacing, motion: m, grid } = FOUNDATIONS;
  const vars = {
    "sc-font-sans": font.sans,
    "sc-font-mono": font.mono,
  };
  for (const [name, style] of Object.entries(styles)) {
    for (const [prop, value] of Object.entries(style)) vars[`sc-type-${name}-${prop}`] = value;
  }
  for (const [key, value] of Object.entries(spacing)) vars[`sc-${key}`] = value;
  for (const [key, value] of Object.entries(m)) vars[`sc-${key}`] = value;
  Object.assign(vars, {
    "sc-grid-columns": grid.columns.sm,
    "sc-grid-gutter": grid.gutter,
    "sc-grid-max-width": grid["max-width"],
    "sc-grid-margin": grid.margin.sm,
    "sc-band-padding": grid["band-padding"].sm,
    "sc-heading-gap": grid["heading-gap"],
    "sc-tile-padding": grid["tile-padding"].sm,
    "sc-radius": grid.radius,
  });
  Object.assign(vars, SEMANTIC_CONSTANTS);
  return vars;
}

const prefixed = (entries) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [`sc-${key}`, value]));

/** Phone title sizes, below md. */
function phoneTypeBlock(selector, indent = "") {
  const vars = {};
  for (const [key, value] of Object.entries(FOUNDATIONS["type-phone"])) {
    const [, role, prop] = key.match(/^(greeting|page-title)-(.*)$/);
    vars[`sc-type-${role}-${prop}`] = value;
  }
  return `${indent}@media (max-width: ${FOUNDATIONS.grid.breakpoints.md - 0.02}px) {
${indent}  ${selector} {
${decls(vars, `${indent}    `)}
${indent}  }
${indent}}`;
}

/** Reduced motion: the OS setting and the Profile toggle (data-motion="reduce"). */
function reducedMotionBlock(selector) {
  const reduced = prefixed(FOUNDATIONS["motion-reduced"]);
  return `/* Reduced motion is a designed state: no travel, no stagger, no loops, fades of 100 ms or less. */
@media (prefers-reduced-motion: reduce) {
  ${selector} {
${decls(reduced, "    ")}
  }
}

${selector}[data-motion="reduce"] {
${decls(reduced)}
}`;
}

function foundationBlock() {
  const { grid } = FOUNDATIONS;
  return `:root {
${decls({ ...BRAND.constants, ...foundationVars() })}
}

/* Semantic colours default to dark (g100): the Console and the admin are dark.
   Each [data-theme] band below sets its own. */
:root {
${decls(semanticColours(G100))}
}

${phoneTypeBlock(":root")}

@media (min-width: ${grid.breakpoints.md}px) {
  :root {
    --sc-grid-columns: ${grid.columns.md};
    --sc-grid-margin: ${grid.margin.md};
  }
}

@media (min-width: ${grid.breakpoints.lg}px) {
  :root {
    --sc-grid-columns: ${grid.columns.lg};
    --sc-band-padding: ${grid["band-padding"].lg};
    --sc-tile-padding: ${grid["tile-padding"].lg};
  }
}

@media (min-width: ${grid.breakpoints.max}px) {
  :root {
    --sc-grid-margin: ${grid.margin.max};
  }
}

${reducedMotionBlock(":root")}

html[data-site-brand="owlcognito"],
[data-brand="owlcognito"] {
${decls(BRAND.owlcognito)}
}`;
}

const header = `/*
 * Syed Carbon tokens. GENERATED by scripts/build-tokens.mjs from
 * @carbon/themes ${require("@carbon/themes/package.json").version} (white, g10, g100), @carbon/type and
 * @carbon/motion. Do not edit by hand: run \`npm run tokens\`.
 *
 * - [data-theme="white"|"g10"|"g100"] on any element sets every --cds-*
 *   colour token and the --brand-* tokens for that subtree (a band is
 *   <section data-theme="g100">). Nothing is set on :root for colours, so the
 *   Console's own Carbon theme (.cds-app) is never affected.
 * - :root carries the theme-independent foundations (--sc-*).
 */`;

function buildCss() {
  return `${header}\n\n${foundationBlock()}\n\n${THEMES.map(themeBlock).join("\n\n")}\n`;
}

// ------------------------------------------------------------ admin tokens
// Django admin ("Al Syed Admin") reads the same values from a plain CSS file
// (no build step on the backend): the foundations, the dark semantic set,
// Plex from its own static folder, and the old --as-* names as aliases so
// enterprise.css (WS-E) can move over one rule at a time.

const ADMIN_FONT_DIR = "backend/apps/users/static/admin/fonts/plex";
const PLEX_UNICODE_RANGE =
  "U+0000, U+000D, U+0020-007E, U+00A0-00A3, U+00A4-00FF, U+0131, U+0152-0153, U+02C6, U+02DA, U+02DC, U+2013-2014, U+2018-201A, U+201C-201E, U+2020-2022, U+2026, U+2030, U+2039-203A, U+2044, U+2074, U+20AC, U+2122, U+2212, U+FB01-FB02";
const ADMIN_FONT_FACES = [
  ["IBM Plex Sans", 300, "IBMPlexSans-Light-Latin1.woff2"],
  ["IBM Plex Sans", 400, "IBMPlexSans-Regular-Latin1.woff2"],
  ["IBM Plex Sans", 600, "IBMPlexSans-SemiBold-Latin1.woff2"],
  ["IBM Plex Mono", 400, "IBMPlexMono-Regular-Latin1.woff2"],
];

const ADMIN_ALIASES = {
  "as-page": "var(--sc-surface-page)",
  "as-surface-1": "var(--sc-surface-01)",
  "as-surface-2": "var(--sc-surface-02)",
  "as-surface-hover": "var(--sc-surface-hover-01)",
  "as-surface-active": "var(--sc-surface-selected-01)",
  "as-border": "var(--sc-border-subtle)",
  "as-border-strong": "var(--sc-border-strong)",
  "as-text-primary": "var(--sc-text-primary)",
  "as-text-secondary": "var(--sc-text-secondary)",
  "as-text-muted": "var(--sc-text-helper)",
  "as-accent": "var(--sc-accent)",
  "as-accent-hover": "var(--sc-accent-hover)",
  "as-accent-ink": "var(--sc-accent-on)",
  "as-accent-wash": "var(--sc-accent-wash)",
  "as-accent-line": "var(--sc-accent)",
  "as-accent-glow": "none",
  "as-focus": "var(--brand-focus)",
  "as-success": "var(--sc-status-success)",
  "as-warning": "var(--sc-status-warning)",
  "as-error": "var(--sc-status-error)",
  "as-radius-card": "var(--sc-radius-surface)",
  "as-radius-tile": "var(--sc-radius-surface)",
  "as-radius-control": "var(--sc-radius-surface)",
  "as-radius-pill": "var(--sc-radius-pill)",
};

function buildAdminCss() {
  // Kept for one release: templates that still preload the Plex files keep resolving (WS-OFFICE moves them to Geist).
  void ADMIN_FONT_FACES;
  void PLEX_UNICODE_RANGE;
  const faces = FONT_FACES.map((face) => face.css("../fonts")).join("\n\n");
  return `/*
 * Al Syed Admin tokens. GENERATED by frontend/scripts/build-tokens.mjs (the
 * same source as the site and the Console). Do not edit by hand: run
 * \`npm run tokens\` in frontend/. Load before enterprise.css.
 *
 * - Geist (variable) + Geist Mono + Handlee from ../fonts/{geist,geist-mono,handlee}/
 *   (SIL OFL 1.1). "IBM Plex Sans"/"IBM Plex Mono" are aliases of the same
 *   Geist files, so older rules render Geist with no extra download.
 * - --sc-*: foundations (type, spacing, motion, shape) and the dark semantic
 *   colours (HackPath canvas); --brand-*: focus, live, success.
 * - --as-*: the old admin names, as aliases of --sc-* (glow is none).
 * - The shadcn-style --background/--card/--accent ... set (same as the site).
 */

${faces}

:root {
  color-scheme: dark;
${decls({ ...BRAND.constants, ...foundationVars() })}
${decls(BRAND.dark)}
${decls(semanticColours(G100))}
${decls(ADMIN_ALIASES)}
}

${adminThemeCss()}

${phoneTypeBlock(":root")}

${reducedMotionBlock(":root")}
`;
}

// ------------------------------------------------------- Carbon bridge
// The Console loads Carbon's own g100 theme (carbon-app.scss). This mixin
// re-declares every --cds-* colour on `.cds-app` with the palette-law values
// (the same as [data-theme="g100"] in tokens.css), so every Carbon widget
// renders black / greys / white / golden white. Included by _carbon-bridge.scss.

function buildCarbonBridgeScss() {
  const cds = Object.fromEntries(Object.entries(themeColours(G100)).map(([name, value]) => [`cds-${name}`, value]));
  return `// GENERATED by scripts/build-tokens.mjs (WS-KIT): do not edit by hand, run \`npm run tokens\`.
// Palette-law Carbon g100 colours for the Console (.cds-app). See _carbon-bridge.scss.

@mixin carbon-bridge-tokens {
${decls(cds)}
${decls(BRAND.dark)}
}
`;
}

function buildJson() {
  return `${JSON.stringify(
    {
      $description: "Syed Carbon tokens (generated by frontend/scripts/build-tokens.mjs; do not edit).",
      source: { "@carbon/themes": require("@carbon/themes/package.json").version },
      themes: Object.fromEntries(
        THEMES.map((theme) => [
          theme.id,
          { colorScheme: theme.dark ? "dark" : "light", colors: themeColours(theme), brand: theme.dark ? BRAND.dark : BRAND.light },
        ])
      ),
      brand: { constants: BRAND.constants, owlcognito: BRAND.owlcognito },
      foundations: FOUNDATIONS,
      semantic: {
        constants: SEMANTIC_CONSTANTS,
        themes: Object.fromEntries(THEMES.map((theme) => [theme.id, semanticColours(theme)])),
      },
    },
    null,
    2
  )}\n`;
}

// --------------------------------------------------------------------- fonts

const FONT_FILES = [
  ["@ibm/plex-sans", "fonts/split/woff2/IBMPlexSans-Light-Latin1.woff2"],
  ["@ibm/plex-sans", "fonts/split/woff2/IBMPlexSans-Regular-Latin1.woff2"],
  ["@ibm/plex-sans", "fonts/split/woff2/IBMPlexSans-SemiBold-Latin1.woff2"],
  ["@ibm/plex-mono", "fonts/split/woff2/IBMPlexMono-Regular-Latin1.woff2"],
  ["@ibm/plex-sans", "LICENSE.txt"],
];

function packageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

// ------------------------------------------------------------------- output

const repo = path.resolve(root, "..");
const fontOutputs = (directory) =>
  FONT_FILES.map(([pkg, relative]) => ({
    file: path.join(directory, path.basename(relative)),
    content: fs.readFileSync(path.join(packageDir(pkg), relative)),
  }));

// Geist / Geist Mono / Handlee (Fontsource, OFL): woff2 subsets + the licence,
// copied into <dir>/{geist,geist-mono,handlee}/ with stable names.
const OFL_TEXT = (family, copyright) => `${copyright}\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThe licence text is available with a FAQ at https://openfontlicense.org\n(copied from the ${family} package in node_modules; see its LICENSE file).\n`;
const hpFontOutputs = (directory) =>
  FONT_FACES.flatMap((face) => [
    ...face.files.map((file) => ({
      file: path.join(directory, face.dir, file),
      content: fs.readFileSync(path.join(packageDir(face.pkg), "files", file)),
    })),
    {
      file: path.join(directory, face.dir, "LICENSE.txt"),
      content: fs.existsSync(path.join(packageDir(face.pkg), "LICENSE"))
        ? fs.readFileSync(path.join(packageDir(face.pkg), "LICENSE"))
        : OFL_TEXT(face.pkg, face.copyright),
    },
  ]).filter((entry, index, all) => all.findIndex((other) => other.file === entry.file) === index);

function fontsCss() {
  return `/*
 * Self-hosted fonts (SIL OFL 1.1). GENERATED by scripts/build-tokens.mjs from
 * scripts/hackpath-theme.mjs; do not edit by hand.
 *
 * Geist (variable 100-900) and Geist Mono from @fontsource-variable, Handlee 400
 * from @fontsource, latin subsets in public/fonts/{geist,geist-mono,handlee}/
 * (latin-ext loads only for characters such as the rupee sign). Geist latin and
 * Handlee latin are preloaded in index.html. "IBM Plex Sans/Mono" are aliases of
 * the same files, so older rules render Geist with no extra download.
 * The "* Fallback" faces are metric-matched local Arial (no layout shift on swap).
 */

${FONT_FACES.map((face) => face.css("/fonts")).join("\n\n")}

${FALLBACK_FACES}
`;
}

const outputs = [
  { file: path.join(root, "src/styles/tokens.css"), content: buildCss() },
  { file: path.join(root, "src/styles/tokens.json"), content: buildJson() },
  { file: path.join(root, "src/styles/theme.css"), content: themeCss() },
  { file: path.join(root, "src/styles/fonts.css"), content: fontsCss() },
  { file: path.join(root, "src/features/app-shell/styles/_carbon-bridge-tokens.scss"), content: buildCarbonBridgeScss() },
  ...fontOutputs(path.join(root, "public/fonts/plex")),
  ...hpFontOutputs(path.join(root, "public/fonts")),
  // Django admin: same tokens and the same font files, served by Django's static
  // files (skipped in a frontend-only checkout, such as the frontend image build).
  ...(fs.existsSync(path.join(repo, "backend/apps/users"))
    ? [
        { file: path.join(repo, "backend/apps/users/static/admin/css/admin-tokens.css"), content: buildAdminCss() },
        ...fontOutputs(path.join(repo, ADMIN_FONT_DIR)),
        ...hpFontOutputs(path.join(repo, "backend/apps/users/static/admin/fonts")),
      ]
    : []),
];

let stale = 0;
for (const { file, content } of outputs) {
  const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const next = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  if (current && current.equals(next)) continue;
  if (check) {
    stale += 1;
    console.error(`stale: ${path.relative(root, file)}`);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  console.log(`wrote ${path.relative(root, file)}`);
}
if (check && stale) {
  console.error("Tokens are out of date: run `npm run tokens`.");
  process.exit(1);
}

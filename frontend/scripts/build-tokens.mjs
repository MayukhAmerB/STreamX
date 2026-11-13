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
//
// Run: npm run tokens          (writes the files)
//      npm run tokens -- --check  (exits 1 when the committed files are stale)
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// -------------------------------------------------------------- brand tokens
// Champagne is an accent on dark bands only (featured-tile rule, active-nav
// underline, certificate hairline, hero eyebrow rule; at most one per
// viewport). On light bands the accent is the darker ink, for text and icons
// only (5.96:1 on white). Focus is monochrome. Live/error and success follow
// the Carbon support colours per theme.
const BRAND = {
  constants: {
    "brand-champagne": "#f3e2b3",
    "brand-champagne-ink": "#7d5f17",
    // OwlCognito (and any future brand) overrides only these two inputs.
    "brand-accent-on-dark": "var(--brand-champagne)",
    "brand-accent-on-light": "var(--brand-champagne-ink)",
  },
  light: {
    "brand-accent": "var(--brand-accent-on-light)",
    "brand-accent-rule": themes.white.borderStrong01,
    "brand-live": colors.red60,
    "brand-success": colors.green60,
    "brand-focus": colors.gray100,
    "brand-band-dark": colors.gray100,
  },
  dark: {
    "brand-accent": "var(--brand-accent-on-dark)",
    "brand-accent-rule": "var(--brand-accent-on-dark)",
    "brand-live": colors.red50,
    "brand-success": colors.green40,
    "brand-focus": colors.white0 || "#ffffff",
    "brand-band-dark": colors.gray100,
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
    sans: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    mono: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace',
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
  },
  spacing: Object.fromEntries(
    Array.from({ length: 13 }, (_unused, index) => {
      const key = String(index + 1).padStart(2, "0");
      return [`spacing-${key}`, themes[`spacing${key}`]];
    })
  ),
  motion: {
    "duration-productive": "110ms",
    "duration-expressive": "240ms",
    "easing-productive": motion.easings.standard.productive,
    "easing-entrance": motion.easings.entrance.expressive,
    "easing-exit": motion.easings.exit.productive,
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
    radius: "0",
  },
};

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
}`;
}

function foundationBlock() {
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
  return `:root {
${decls({ ...BRAND.constants, ...vars })}
}

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

/* Motion off: durations collapse, so nothing animates (content is visible by default anyway). */
@media (prefers-reduced-motion: reduce) {
  :root {
    --sc-duration-productive: 0ms;
    --sc-duration-expressive: 0ms;
  }
}

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

const outputs = [
  { file: path.join(root, "src/styles/tokens.css"), content: buildCss() },
  { file: path.join(root, "src/styles/tokens.json"), content: buildJson() },
  ...FONT_FILES.map(([pkg, relative]) => ({
    file: path.join(root, "public/fonts/plex", path.basename(relative)),
    content: fs.readFileSync(path.join(packageDir(pkg), relative)),
  })),
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

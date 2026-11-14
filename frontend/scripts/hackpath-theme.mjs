// HackPath-philosophy design tokens (PHILOSOPHY §3, BUILD_PLAN §1). OWNER: WS-KIT.
//
// The single source for the new visual language. scripts/build-tokens.mjs
// writes them to src/styles/theme.css (site + Console) and into
// backend/apps/users/static/admin/css/admin-tokens.css (Django admin);
// tailwind.config.js maps them. Palette law: black, greys, whites, golden
// white (#F3E2B3 family) only. Do not add a hue here: scripts/check-palette.mjs
// fails the lint.

const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
// latin-ext carries the rupee sign (U+20B9, inside U+20AD-20C0): it downloads only when a page shows one.
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

export const HP = {
  font: {
    sans: '"Geist", "Geist Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    mono: '"Geist Mono", "Geist Mono Fallback", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace',
    hand: '"Handlee", "Handlee Fallback", "Segoe Print", "Bradley Hand", cursive',
  },
  radius: "0.625rem",
  dark: {
    background: "#000000",
    foreground: "#fafafa",
    surface1: "#070707",
    card: "#0a0a0a",
    cardRaised: "#111111",
    muted: "#171717",
    mutedForeground: "#a1a1a1", // 8.0:1 on black: body copy
    subtleForeground: "#8a8a8a", // 5.6:1 on black, 5.3:1 on #0a0a0a: the text floor
    placeholder: "#737373", // placeholders and disabled decoration only, never labels
    border: "rgba(255, 255, 255, 0.1)",
    borderSoft: "rgba(255, 255, 255, 0.06)",
    borderStrong: "rgba(255, 255, 255, 0.18)",
    input: "rgba(255, 255, 255, 0.35)",
    accent: "#f3e2b3",
    accentStrong: "#f8edcf",
    accentDeep: "#e6d29c",
    accentForeground: "#0a0a0a", // 15.6:1 on golden white
    accentWash: "rgba(243, 226, 179, 0.08)",
    accentShadow: "#6b6150",
  },
};

/** Self-hosted faces. `files` are copied from the Fontsource package's files/ folder. */
export const FONT_FACES = [
  {
    family: "Geist",
    pkg: "@fontsource-variable/geist",
    dir: "geist",
    copyright: "Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)",
    files: ["geist-latin-wght-normal.woff2", "geist-latin-ext-wght-normal.woff2"],
    faces: [
      { file: "geist-latin-wght-normal.woff2", weight: "100 900", range: LATIN },
      { file: "geist-latin-ext-wght-normal.woff2", weight: "100 900", range: LATIN_EXT },
    ],
    // Older rules that still name IBM Plex render Geist from the same (cached) files.
    aliases: ["IBM Plex Sans"],
  },
  {
    family: "Geist Mono",
    pkg: "@fontsource-variable/geist-mono",
    dir: "geist-mono",
    copyright: "Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)",
    files: ["geist-mono-latin-wght-normal.woff2", "geist-mono-latin-ext-wght-normal.woff2"],
    faces: [
      { file: "geist-mono-latin-wght-normal.woff2", weight: "100 900", range: LATIN },
      { file: "geist-mono-latin-ext-wght-normal.woff2", weight: "100 900", range: LATIN_EXT },
    ],
    aliases: ["IBM Plex Mono"],
  },
  {
    family: "Handlee",
    pkg: "@fontsource/handlee",
    dir: "handlee",
    copyright: "Copyright (c) 2011, Admix Designs (http://www.admixdesigns.com) with Reserved Font Name Handlee.",
    files: ["handlee-latin-400-normal.woff2"],
    faces: [{ file: "handlee-latin-400-normal.woff2", weight: "400", range: LATIN }],
    aliases: [],
  },
].map((face) => ({
  ...face,
  /** @font-face rules for this family (and its aliases), with URLs under `base`. */
  css(base) {
    return [face.family, ...face.aliases]
      .flatMap((family) =>
        face.faces.map(
          (item) => `@font-face {
  font-family: "${family}";
  font-style: normal;
  font-weight: ${item.weight};
  font-display: swap;
  src: url("${base}/${face.dir}/${item.file}") format("woff2");
  unicode-range: ${item.range};
}`
        )
      )
      .join("\n\n");
  },
}));

/**
 * Metric-matched fallbacks (local Arial scaled to each face's metrics) so the
 * swap from the system font to Geist/Handlee moves nothing (CLS < 0.05).
 * The overrides are measured font metrics (ascent/descent/x-width ratios).
 */
export const FALLBACK_FACES = `@font-face {
  font-family: "Geist Fallback";
  src: local("Arial"), local("ArialMT"), local("Liberation Sans"), local("Helvetica");
  ascent-override: 95.94%;
  descent-override: 28.16%;
  line-gap-override: 0%;
  size-adjust: 104.76%;
}

@font-face {
  font-family: "Geist Mono Fallback";
  src: local("Arial"), local("ArialMT"), local("Liberation Sans"), local("Helvetica");
  ascent-override: 74.67%;
  descent-override: 21.92%;
  line-gap-override: 0%;
  size-adjust: 134.59%;
}

@font-face {
  font-family: "Handlee Fallback";
  src: local("Arial"), local("ArialMT"), local("Liberation Sans"), local("Helvetica");
  ascent-override: 103.58%;
  descent-override: 44.47%;
  line-gap-override: 0%;
  size-adjust: 90.17%;
}`;

/** "#rrggbb" -> "r g b" (for rgb(var(--x) / <alpha-value>) in Tailwind). */
const channels = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** The shadcn-style variables. Colours that take a Tailwind alpha modifier are channel triplets. */
export function themeVars() {
  const d = HP.dark;
  return {
    background: channels(d.background),
    foreground: channels(d.foreground),
    "surface-1": channels(d.surface1),
    card: channels(d.card),
    "card-foreground": channels(d.foreground),
    "card-raised": channels(d.cardRaised),
    popover: channels(d.cardRaised),
    "popover-foreground": channels(d.foreground),
    muted: channels(d.muted),
    "muted-foreground": channels(d.mutedForeground),
    "subtle-foreground": channels(d.subtleForeground),
    placeholder: channels(d.placeholder),
    primary: channels(d.foreground),
    "primary-foreground": channels(d.background),
    secondary: channels(d.muted),
    "secondary-foreground": channels(d.foreground),
    accent: channels(d.accent),
    "accent-strong": channels(d.accentStrong),
    "accent-deep": channels(d.accentDeep),
    "accent-foreground": channels(d.accentForeground),
    "accent-shadow": channels(d.accentShadow),
    ring: channels(d.accent),
    border: d.border,
    "border-soft": d.borderSoft,
    "border-strong": d.borderStrong,
    input: d.input,
    "accent-wash": d.accentWash,
    radius: HP.radius,
    "font-sans": HP.font.sans,
    "font-mono": HP.font.mono,
    "font-hand": HP.font.hand,
    glow: "0 0 0 1px rgb(243 226 179 / 0.35), 0 0 32px -6px rgb(243 226 179 / 0.45)",
    "ease-standard": "cubic-bezier(0.4, 0, 0.2, 1)",
    "ease-out": "cubic-bezier(0, 0, 0.2, 1)",
    "ease-settle": "cubic-bezier(0.22, 1, 0.36, 1)",
  };
}

const decls = (vars, indent = "  ") =>
  Object.entries(vars)
    .map(([name, value]) => `${indent}--${name}: ${value};`)
    .join("\n");

const HEADER = `/*
 * HackPath-philosophy theme (PHILOSOPHY.md §3, BUILD_PLAN §1). GENERATED by
 * scripts/build-tokens.mjs from scripts/hackpath-theme.mjs. Do not edit by
 * hand: run \`npm run tokens\`.
 *
 * shadcn pattern on Tailwind 3.4: colours that take an alpha modifier are
 * "r g b" triplets, used as rgb(var(--accent) / <alpha-value>).
 * Palette law: black, greys, whites and golden white (#f3e2b3) only.
 */`;

/** src/styles/theme.css: fonts are declared in fonts.css (preloaded files), tokens here. */
export function themeCss() {
  return `${HEADER}

:root {
  color-scheme: dark;
${decls(themeVars())}
}
`;
}

/** The same set for the Django admin (admin-tokens.css appends it after its fonts). */
export function adminThemeCss() {
  return `/* HackPath-philosophy tokens (same values as the site's src/styles/theme.css). */
${FALLBACK_FACES}

:root {
${decls(themeVars())}
}`;
}

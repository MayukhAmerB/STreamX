// Palette law (HackPath redesign, PHILOSOPHY §3.1 / BUILD_PLAN §1.1). OWNER: WS-KIT.
//
// The only colours allowed anywhere in the product: black, greys, whites, and
// golden white (the #F3E2B3 family) with its glow. Every other hue is mapped
// to luminance (status = icon + word + luminance, never hue).
//
// Shared by scripts/build-tokens.mjs (it filters Carbon's themes through
// `toLawful`), scripts/check-palette.mjs (the lint) and the vitest suite.
// No dependencies.

/** The golden-white family, by name. Anything else golden must be within GOLD_TOLERANCE of one of these. */
export const GOLDEN = Object.freeze({
  accent: "#f3e2b3", // --accent: golden white
  strong: "#f8edcf", // --accent-strong: hover
  deep: "#e6d29c", // --accent-deep: pressed
  hover: "#fff0c8", // legacy --sc-accent-hover
  shadow: "#6b6150", // the tactile CTA's 4px under-shadow (#F3E2B3 mixed 38% into #080c13): decoration only
});

/** Hue window (degrees) and the per-channel distance that still counts as "the golden-white family". */
const GOLD_HUE = [36, 52];
const GOLD_TOLERANCE = 28;

/** Greys may carry a hair of tint from anti-aliasing tools (e.g. #f4f4f5). */
const GREY_TOLERANCE = 3;

const NAMED = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  silver: [192, 192, 192],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  gainsboro: [220, 220, 220],
  whitesmoke: [245, 245, 245],
  snow: [255, 250, 250],
};

/** Colour keywords that are never a violation. */
export const NEUTRAL_KEYWORDS = new Set(["transparent", "currentcolor", "inherit", "initial", "unset", "none", "canvas", "canvastext"]);

/** Chromatic CSS keywords we look for in source (the lint only flags these words in colour positions). */
export const CHROMATIC_KEYWORDS = [
  "red", "green", "blue", "yellow", "orange", "purple", "violet", "pink", "cyan", "magenta", "lime", "teal",
  "navy", "maroon", "olive", "aqua", "fuchsia", "indigo", "gold", "crimson", "tomato", "coral", "salmon",
  "turquoise", "orchid", "plum", "khaki", "chartreuse", "skyblue", "royalblue", "dodgerblue", "steelblue",
  "seagreen", "forestgreen", "darkred", "darkgreen", "darkblue", "darkorange", "hotpink", "deeppink",
];

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r1, g1, b1].map((v) => Math.round((v + m) * 255));
}

/**
 * Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() (comma or space syntax, incl. "/ alpha"),
 * hsl()/hsla() and the named greys. Returns { r, g, b, a } or null.
 */
export function parseColour(input) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) return null;
  if (NAMED[text]) return { r: NAMED[text][0], g: NAMED[text][1], b: NAMED[text][2], a: 1 };
  let match = text.match(/^#([0-9a-f]{3,8})$/);
  if (match) {
    let hex = match[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = (i) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  match = text.match(/^rgba?\((.*)\)$/);
  if (match) {
    const parts = match[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (p) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if ([r, g, b, alpha].some((v) => Number.isNaN(v))) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: alpha };
  }
  match = text.match(/^hsla?\((.*)\)$/);
  if (match) {
    const parts = match[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if ([h, s, l, alpha].some((v) => Number.isNaN(v))) return null;
    const [r, g, b] = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
    return { r, g, b, a: alpha };
  }
  return null;
}

function hue({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

export const isGrey = ({ r, g, b }) => Math.max(r, g, b) - Math.min(r, g, b) <= GREY_TOLERANCE;

/** True when the colour is golden white (or one of its named shades) at any alpha. */
export function isGolden(colour) {
  const h = hue(colour);
  if (h < GOLD_HUE[0] || h > GOLD_HUE[1]) return false;
  return Object.values(GOLDEN).some((hex) => {
    const ref = parseColour(hex);
    return Math.max(Math.abs(ref.r - colour.r), Math.abs(ref.g - colour.g), Math.abs(ref.b - colour.b)) <= GOLD_TOLERANCE;
  });
}

/** True when a CSS colour string obeys the palette law. Unparseable strings return true (not a colour). */
export function isLawful(input) {
  const text = String(input || "").trim().toLowerCase();
  if (NEUTRAL_KEYWORDS.has(text)) return true;
  const colour = parseColour(text);
  if (!colour) return true;
  if (colour.a === 0) return true;
  return isGrey(colour) || isGolden(colour);
}

const linear = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const delinear = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));

/** WCAG relative luminance (0..1). */
export const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** WCAG contrast ratio between two opaque colours (strings or parsed). */
export function contrast(a, b) {
  const la = luminance(typeof a === "string" ? parseColour(a) : a);
  const lb = luminance(typeof b === "string" ? parseColour(b) : b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex2 = (n) => clamp(n, 0, 255).toString(16).padStart(2, "0");

/**
 * Maps any colour onto the law: lawful colours come back unchanged; a hue
 * becomes the grey of the same WCAG luminance (so contrast pairs survive),
 * keeping its alpha and its original syntax family (hex or rgba).
 */
export function toLawful(input) {
  if (isLawful(input)) return input;
  const colour = parseColour(input);
  const grey = delinear(luminance(colour));
  if (colour.a < 1) return `rgba(${grey}, ${grey}, ${grey}, ${Number(colour.a.toFixed(3))})`;
  return `#${hex2(grey)}${hex2(grey)}${hex2(grey)}`;
}

/** Every colour literal in a chunk of CSS/JS text: hex, rgb[a](), hsl[a](). */
export const COLOUR_LITERAL = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?)\([^()]*\)/g;

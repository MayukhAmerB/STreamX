import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../..");
const read = (relative) => fs.readFileSync(path.join(frontend, relative), "utf8");

describe("Syed Carbon tokens", () => {
  const css = read("src/styles/tokens.css");

  it("is up to date with scripts/build-tokens.mjs and the installed Carbon packages", () => {
    expect(() => execFileSync(process.execPath, ["scripts/build-tokens.mjs", "--check"], { cwd: frontend, stdio: "pipe" })).not.toThrow();
  });

  it("scopes colours to [data-theme] only, never :root (the Console keeps its own theme)", () => {
    for (const theme of ["white", "g10", "g100"]) expect(css).toContain(`[data-theme="${theme}"] {`);
    const rootBlocks = css.match(/:root \{[^}]*\}/g) || [];
    expect(rootBlocks.length).toBeGreaterThan(0);
    rootBlocks.forEach((block) => expect(block).not.toContain("--cds-"));
  });

  // HackPath redesign (PHILOSOPHY §3.1): black canvas, golden-white focus on dark,
  // and the palette law (live and status are luminance or golden white, never red).
  it("uses the black canvas for dark bands, a golden-white focus ring and no hue for live", () => {
    const block = (theme) => css.slice(css.indexOf(`[data-theme="${theme}"] {`)).split("\n}\n")[0];
    expect(block("g100")).toContain("--cds-background: #000000;");
    expect(block("g100")).toContain("--brand-focus: #f3e2b3;");
    expect(block("white")).toContain("--brand-focus: #161616;");
    expect(block("g100")).toContain("--brand-accent: var(--brand-accent-on-dark);");
    expect(block("white")).toContain("--brand-accent: var(--brand-accent-on-light);");
    expect(css).toContain("--brand-champagne: #f3e2b3;");
    expect(css).toContain("--brand-champagne-ink: #262626;");
    expect(block("white")).toContain("--brand-live: #000000;");
    expect(block("g100")).toContain("--brand-live: #f3e2b3;");
  });

  it("carries the foundations: Geist, the .625rem radius, Carbon motion, the 2x grid", () => {
    expect(css).toContain('--sc-font-sans: "Geist", "Geist Fallback"');
    expect(css).toContain("--sc-radius: 0.625rem;");
    expect(css).toContain("--sc-duration-productive: 110ms;");
    expect(css).toContain("--sc-duration-expressive: 240ms;");
    expect(css).toContain("--sc-easing-productive: cubic-bezier(0.2, 0, 0.38, 0.9);");
    expect(css).toMatch(/@media \(min-width: 1056px\) \{\s+:root \{\s+--sc-grid-columns: 16;\s+--sc-band-padding: 6rem;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("carries the UI overhaul motion scale (§2.2) with the old names as aliases", () => {
    const expected = {
      "duration-fast-01": "70ms",
      "duration-fast-02": "110ms",
      "duration-moderate-01": "150ms",
      "duration-moderate-02": "240ms",
      "duration-slow-01": "400ms",
      "duration-slow-02": "700ms",
      "ease-standard-productive": "cubic-bezier(0.2, 0, 0.38, 0.9)",
      "ease-standard-expressive": "cubic-bezier(0.4, 0.14, 0.3, 1)",
      "ease-entrance-productive": "cubic-bezier(0, 0, 0.38, 0.9)",
      "ease-entrance-expressive": "cubic-bezier(0, 0, 0.3, 1)",
      "ease-exit-productive": "cubic-bezier(0.2, 0, 1, 0.9)",
      "ease-exit-expressive": "cubic-bezier(0.4, 0.14, 1, 1)",
      "motion-distance-01": "4px",
      "motion-distance-02": "8px",
      "motion-distance-03": "16px",
      "stagger-step": "40ms",
      "stagger-max": "6",
      "live-period": "2000ms",
      "shimmer-period": "2000ms",
      "skeleton-delay": "300ms",
      "skeleton-min": "250ms",
    };
    for (const [name, value] of Object.entries(expected)) expect(css).toContain(`--sc-${name}: ${value};`);
  });

  it("designs reduced motion for the OS setting and the Profile toggle (data-motion)", () => {
    for (const opener of ["@media (prefers-reduced-motion: reduce) {\n  :root {", ':root[data-motion="reduce"] {']) {
      const start = css.indexOf(opener);
      expect(start, opener).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf("}", start));
      expect(block).toContain("--sc-motion-distance-02: 0px;");
      expect(block).toContain("--sc-stagger-step: 0ms;");
      expect(block).toContain("--sc-duration-moderate-02: 0ms;");
      expect(block).toContain("--sc-duration-slow-02: 0ms;");
      expect(block).toContain("--sc-duration-moderate-01: 100ms;");
    }
  });

  it("defines one semantic vocabulary: g100 surfaces by default, light sets on light bands", () => {
    const root = css.match(/:root \{\n {2}--sc-surface-page[^}]*\}/)?.[0] || "";
    expect(root).toContain("--sc-surface-page: #000000;");
    expect(root).toContain("--sc-surface-01: #0a0a0a;");
    expect(root).toContain("--sc-surface-02: #111111;");
    expect(root).toContain("--sc-border-subtle: rgba(255, 255, 255, 0.1);");
    const block = (theme) => css.slice(css.indexOf(`[data-theme="${theme}"] {`)).split("\n}\n")[0];
    expect(block("white")).toContain("--sc-surface-page: #ffffff;");
    expect(block("white")).toContain("--sc-surface-01: #f4f4f4;");
    expect(css).toContain("--sc-accent-wash: rgba(243, 226, 179, 0.08);");
    expect(css).toContain("--sc-radius-surface: 0.625rem;");
    expect(css).toContain("--sc-radius-pill: 999px;");
    expect(css).toContain("--sc-shadow-floating: 0 2px 6px rgba(0, 0, 0, 0.3);");
    expect(css).not.toMatch(/glow/i);
  });

  it("generates admin-tokens.css for Django with Geist, the dark set and --as-* aliases", () => {
    const admin = fs.readFileSync(path.join(frontend, "../backend/apps/users/static/admin/css/admin-tokens.css"), "utf8");
    expect(admin).toContain("GENERATED by frontend/scripts/build-tokens.mjs");
    expect(admin).toMatch(/font-family: "Geist";\s+font-style: normal;\s+font-weight: 100 900;/);
    expect(admin).toContain('url("../fonts/geist/geist-latin-wght-normal.woff2")');
    expect(admin).toMatch(/font-family: "Handlee";/);
    expect(admin).toContain("--sc-surface-page: #000000;");
    expect(admin).toContain("--brand-focus: #f3e2b3;");
    expect(admin).toContain("--as-radius-card: var(--sc-radius-surface);");
    expect(admin).toContain("--as-accent-glow: none;");
    expect(admin).toContain(':root[data-motion="reduce"]');
    expect(admin).not.toContain("Inter");
    for (const file of ["IBMPlexSans-Light-Latin1.woff2", "IBMPlexSans-Regular-Latin1.woff2", "IBMPlexSans-SemiBold-Latin1.woff2", "IBMPlexMono-Regular-Latin1.woff2", "LICENSE.txt"]) {
      expect(fs.existsSync(path.join(frontend, "../backend/apps/users/static/admin/fonts/plex", file)), file).toBe(true);
    }
  });

  it("ships a JSON copy for the mobile app", () => {
    const json = JSON.parse(read("src/styles/tokens.json"));
    expect(Object.keys(json.themes)).toEqual(["white", "g10", "g100"]);
    expect(json.themes.g100.colors.background).toBe("#000000");
  });

  it("self-hosts Geist, Geist Mono and Handlee (OFL), preloading Geist everywhere and Handlee on hero routes", () => {
    const families = {
      geist: ["geist-latin-wght-normal.woff2", "geist-latin-ext-wght-normal.woff2", "LICENSE.txt"],
      "geist-mono": ["geist-mono-latin-wght-normal.woff2", "LICENSE.txt"],
      handlee: ["handlee-latin-400-normal.woff2", "LICENSE.txt"],
    };
    for (const [dir, files] of Object.entries(families)) {
      for (const file of files) expect(fs.existsSync(path.join(frontend, "public/fonts", dir, file)), `${dir}/${file}`).toBe(true);
      expect(read(`public/fonts/${dir}/LICENSE.txt`)).toMatch(/Open Font License/i);
    }
    const html = read("index.html");
    expect(html).toContain('<link rel="preload" href="/fonts/geist/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />');
    expect(html).toContain("/fonts/handlee/handlee-latin-400-normal.woff2");
    expect(html).not.toContain('preload" href="/fonts/geist-mono');
    const fonts = read("src/styles/fonts.css");
    expect(fonts).toMatch(/"Geist";\s+font-style: normal;\s+font-weight: 100 900;\s+font-display: swap;/);
    expect(fonts).toMatch(/"Geist Mono";\s+font-style: normal;\s+font-weight: 100 900;/);
    expect(fonts).toMatch(/"Handlee";\s+font-style: normal;\s+font-weight: 400;/);
    // The rupee sign (U+20B9) is in the latin-ext file, which loads only when a page uses it.
    expect(fonts).toMatch(/geist-latin-ext-wght-normal\.woff2[^}]*U\+20AD-20C0/);
    // Metric-matched fallback faces keep the font swap free of layout shift (CLS < 0.05).
    expect(fonts).toMatch(/font-family: "Geist Fallback";[^}]*size-adjust/);
  });
});

describe("public bundle boundary", () => {
  it("keeps Carbon component code and CSS out of the site kit", () => {
    const files = fs.readdirSync(here).filter((name) => /\.(jsx?|css)$/.test(name) && !/\.test\./.test(name));
    expect(files.length).toBeGreaterThan(10);
    for (const name of files) {
      expect(fs.readFileSync(path.join(here, name), "utf8"), name).not.toMatch(/(?:from|import|@use|@import)\s*\(?["']@carbon\//);
    }
  });

  it("renders the public site at 1:1 (no html zoom) with Plex on the public layout", () => {
    const index = read("src/index.css");
    expect(index).not.toMatch(/^\s*zoom:/m);
    expect(index).toMatch(/\.site-public \{\s+--font-sans: var\(--sc-font-sans\);/);
    expect(read("src/layouts/AppLayout.jsx")).toContain("site-public");
  });

  it("hands over from the boot loader in at most 150 ms with no extra hold", () => {
    const main = read("src/main.jsx");
    expect(main).not.toMatch(/MIN_BOOT_LOADER_MS/);
    expect(main).toContain("const BOOT_FADE_MS = 150;");
    const html = read("index.html");
    expect(html).not.toMatch(/transition: opacity (?:[2-9]\d\d|\d{4,})ms/);
  });
});

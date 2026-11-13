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

  it("uses #161616 for dark bands, a monochrome focus ring and champagne only as the dark accent", () => {
    const block = (theme) => css.slice(css.indexOf(`[data-theme="${theme}"] {`)).split("\n}\n")[0];
    expect(block("g100")).toContain("--cds-background: #161616;");
    expect(block("g100")).toContain("--brand-focus: #ffffff;");
    expect(block("white")).toContain("--brand-focus: #161616;");
    expect(block("g100")).toContain("--brand-accent: var(--brand-accent-on-dark);");
    expect(block("white")).toContain("--brand-accent: var(--brand-accent-on-light);");
    expect(css).toContain("--brand-champagne: #f3e2b3;");
    expect(css).toContain("--brand-champagne-ink: #7d5f17;");
    expect(block("white")).toContain("--brand-live: #da1e28;");
    expect(block("g100")).toContain("--brand-live: #fa4d56;");
  });

  it("carries the foundations: Plex, 0 radius, Carbon motion, the 2x grid", () => {
    expect(css).toContain('--sc-font-sans: "IBM Plex Sans"');
    expect(css).toContain("--sc-radius: 0;");
    expect(css).toContain("--sc-duration-productive: 110ms;");
    expect(css).toContain("--sc-duration-expressive: 240ms;");
    expect(css).toContain("--sc-easing-productive: cubic-bezier(0.2, 0, 0.38, 0.9);");
    expect(css).toMatch(/@media \(min-width: 1056px\) \{\s+:root \{\s+--sc-grid-columns: 16;\s+--sc-band-padding: 6rem;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("ships a JSON copy for the mobile app", () => {
    const json = JSON.parse(read("src/styles/tokens.json"));
    expect(Object.keys(json.themes)).toEqual(["white", "g10", "g100"]);
    expect(json.themes.g100.colors.background).toBe("#161616");
  });

  it("self-hosts Plex Sans 300/400/600 and Plex Mono 400 with the OFL licence, preloading 300 and 400", () => {
    for (const file of [
      "IBMPlexSans-Light-Latin1.woff2",
      "IBMPlexSans-Regular-Latin1.woff2",
      "IBMPlexSans-SemiBold-Latin1.woff2",
      "IBMPlexMono-Regular-Latin1.woff2",
      "LICENSE.txt",
    ]) {
      expect(fs.existsSync(path.join(frontend, "public/fonts/plex", file))).toBe(true);
    }
    const html = read("index.html");
    expect(html).toContain('<link rel="preload" href="/fonts/plex/IBMPlexSans-Light-Latin1.woff2" as="font" type="font/woff2" crossorigin />');
    expect(html).toContain('<link rel="preload" href="/fonts/plex/IBMPlexSans-Regular-Latin1.woff2" as="font" type="font/woff2" crossorigin />');
    const fonts = read("src/styles/fonts.css");
    for (const weight of [300, 400, 600]) expect(fonts).toMatch(new RegExp(`"IBM Plex Sans";\\s+font-style: normal;\\s+font-weight: ${weight};`));
    expect(fonts).toMatch(/"IBM Plex Mono";\s+font-style: normal;\s+font-weight: 400;/);
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

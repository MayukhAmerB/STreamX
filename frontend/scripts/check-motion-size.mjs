#!/usr/bin/env node
// Motion code weight budget (UI overhaul plan §2.4). OWNER: WS-A.
// Our own motion helpers (hooks.js: count-up, FLIP, stagger, view
// transitions, in-view, reduced motion) <= 2 KB gzipped, the four motion
// components (LiveDot, CountUp, RollingDigits, Meter) <= 1.5 KB, motion CSS
// <= 4 KB gzipped, no new runtime dependencies. Minifies the kit with esbuild (already installed with
// Vite) and gzips it, so the number matches what ships.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { transform } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const gz = (text) => zlib.gzipSync(Buffer.from(text), { level: 9 }).length;

const BUDGET = { helpers: 2048, components: 1536, css: 4096 };

const minified = async (file) => (await transform(read(file), { loader: file.endsWith(".jsx") ? "jsx" : "js", jsx: "automatic", minify: true, format: "esm" })).code;
const helpers = await minified("src/site-kit/motion/hooks.js");
const components = await minified("src/site-kit/motion/components.jsx");
const css = (await transform(read("src/site-kit/motion/motion.css"), { loader: "css", minify: true })).code;

const sizes = { helpers: gz(helpers), components: gz(components), css: gz(css) };
let failed = false;
for (const kind of Object.keys(BUDGET)) {
  const ok = sizes[kind] <= BUDGET[kind];
  failed ||= !ok;
  console.log(`motion ${kind}: ${sizes[kind]} B gzipped (budget ${BUDGET[kind]} B) ${ok ? "ok" : "OVER BUDGET"}`);
}
if (failed) process.exit(1);

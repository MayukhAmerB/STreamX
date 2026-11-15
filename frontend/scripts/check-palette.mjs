#!/usr/bin/env node
// Palette-law lint (HackPath redesign, PHILOSOPHY §3.1, BUILD_PLAN §1.1). OWNER: WS-KIT.
// No dependencies. Fails when a source file uses a colour outside the law:
// black, greys, whites and golden white (#F3E2B3 family, any alpha, incl. glows).
//
//   node scripts/check-palette.mjs           check (exit 1 on a NEW finding)
//   node scripts/check-palette.mjs --list    print every finding, baselined ones too
//   node scripts/check-palette.mjs --prune   drop baseline entries that are fixed (never adds)
//   node scripts/check-palette.mjs --write-baseline   (re)write the baseline (WS-KIT only)
//
// What it reads: colour literals (#hex, rgb[a](), hsl[a]()) and chromatic CSS
// keywords in colour properties, in frontend/src (css, scss, js, jsx; tests
// skipped), frontend/index.html, the Django back-office templates and admin
// CSS/JS, and the labs site's top-level HTML/CSS. Tailwind's named hues
// (`bg-red-500`) are lawful because tailwind.config.js maps them to greys.
//
// Allowed exceptions (and only these):
// - OwlCognito brand rules (BUILD_PLAN D11, owner question Q3): any CSS rule
//   whose selector mentions `owlcognito`, and JS lines that mention it.
// - The Qur'an 20:114 calligraphy artwork (src/assets/brand/**): gold by design.
// - A line carrying `palette-law: allow <reason>` in a comment (reviewed by WS-KIT).
// - scripts/palette-baseline.json: findings that existed when the rule was
//   switched on, each owned by a workstream that is removing it. A baselined
//   finding that disappears is reported so its entry can be deleted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CHROMATIC_KEYWORDS, COLOUR_LITERAL, isLawful } from "./palette-law.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const args = new Set(process.argv.slice(2));
const baselinePath = path.join(root, "scripts/palette-baseline.json");

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".vite", "generated", "coverage"]);
const SKIP_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
// Hybrid release (owner, Nov 2026): the public website is the Friday 13 Nov
// site (7a444898) restored verbatim, with its own colours. These files are
// exempt as a whole; every other file (and every new piece) stays under the law.
const FRIDAY_WEBSITE = [
  "frontend/src/components/NationalDeskArt.jsx",
  "frontend/src/components/Navbar.css",
  "frontend/src/features/youtube/YouTube.css",
  "frontend/src/pages/AccountsDirectoryPage.css",
  "frontend/src/pages/HallOfFamePage.jsx",
  "frontend/src/pages/JoinAlSyedPage.css",
  "frontend/src/pages/LandingPage.jsx",
  "frontend/src/pages/WatchPage.jsx",
];
const EXEMPT_PATH = [/^frontend\/src\/assets\/brand\//, { test: (relative) => FRIDAY_WEBSITE.includes(relative) }];

function walk(directory, pattern, out = [], { recurse = true } = {}) {
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recurse && !SKIP_DIRS.has(entry.name)) walk(target, pattern, out, { recurse });
    } else if (pattern.test(entry.name) && !SKIP_FILE.test(entry.name)) out.push(target);
  }
  return out;
}

export function sourceFiles() {
  return [
    ...walk(path.join(root, "src"), /\.(css|scss|js|jsx|ts|tsx|html)$/),
    path.join(root, "index.html"),
    ...walk(path.join(repo, "backend/templates"), /\.html$/),
    ...walk(path.join(repo, "backend/apps/users/static/admin"), /\.(css|js)$/),
    ...walk(path.join(repo, "OSINTCTF"), /\.(css|html)$/, [], { recurse: false }),
  ].filter((file) => fs.existsSync(file));
}

/** Comments become spaces (offsets and lines kept); `palette-law: allow` lines are remembered first. */
function prepare(text, { css }) {
  const allowLines = new Set();
  text.split("\n").forEach((line, index) => {
    if (/palette-law:\s*allow\b/.test(line)) allowLines.add(index + 1);
  });
  let stripped = text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
  // `//` comments (not inside url(...) or "https://").
  stripped = stripped.replace(/(^|[^:"'(\w])\/\/[^\n]*/g, (match, lead) => lead + " ".repeat(match.length - lead.length));
  if (!css) stripped = stripped.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "));
  return { stripped, allowLines };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** For CSS: the selectors enclosing each offset (a stack walk over braces). */
function selectorAt(text) {
  const marks = [];
  const stack = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      stack.push(text.slice(start, index).trim());
      marks.push([index, stack.join(" ")]);
      start = index + 1;
    } else if (char === "}") {
      stack.pop();
      marks.push([index, stack.join(" ")]);
      start = index + 1;
    } else if (char === ";") start = index + 1;
  }
  return (offset) => {
    let found = "";
    for (const [at, selector] of marks) {
      if (at > offset) break;
      found = selector;
    }
    return found;
  };
}

const KEYWORD_RE = new RegExp(
  `(?:^|[\\s;{"'\`])(?:color|background(?:-color)?|border(?:-[a-z]+)*-color|border(?:-(?:top|right|bottom|left))?|outline(?:-color)?|fill|stroke|text-decoration-color|caret-color|accent-color|box-shadow|text-shadow)\\s*:\\s*([^;{}\\n]*)`,
  "gi"
);
const CHROMATIC_RE = new RegExp(`\\b(${CHROMATIC_KEYWORDS.join("|")})\\b`, "i");

export function checkText(text, relative) {
  if (EXEMPT_PATH.some((pattern) => pattern.test(relative))) return [];
  const css = /\.(s?css)$/.test(relative);
  const { stripped, allowLines } = prepare(text, { css });
  const lines = stripped.split("\n");
  const rawLines = text.split("\n");
  const selector = css ? selectorAt(stripped) : null;
  const findings = [];
  const excused = (index) => {
    const line = lineOf(stripped, index);
    if (allowLines.has(line)) return true;
    if (css) return /owlcognito/i.test(selector(index));
    return /owlcognito/i.test(rawLines[line - 1] || "") || /owlcognito/i.test(lines[line - 2] || "");
  };

  for (const match of stripped.matchAll(COLOUR_LITERAL)) {
    const literal = match[0];
    // "#abc" inside a URL fragment or an id selector is not a colour.
    if (literal.startsWith("#")) {
      const before = stripped[match.index - 1] || "";
      if (/[\w/&=?-]/.test(before)) continue;
      const after = stripped[match.index + literal.length] || "";
      if (/[\w-]/.test(after)) continue;
      if (css && /^#[0-9a-f]{3,8}$/i.test(literal) && /^\s*[{,.:[>+~]/.test(stripped.slice(match.index + literal.length))) continue;
      if (![3, 4, 6, 8].includes(literal.length - 1)) continue;
    }
    if (isLawful(literal) || excused(match.index)) continue;
    findings.push({ file: relative, line: lineOf(stripped, match.index), colour: literal.replace(/\s+/g, " ").toLowerCase() });
  }

  if (css) {
    for (const match of stripped.matchAll(KEYWORD_RE)) {
      const value = match[1].replace(/url\([^)]*\)|var\([^)]*\)/gi, "");
      const hit = value.match(CHROMATIC_RE);
      if (!hit || excused(match.index)) continue;
      findings.push({ file: relative, line: lineOf(stripped, match.index), colour: hit[1].toLowerCase() });
    }
  }
  return findings;
}

export function checkFile(file) {
  const relative = path.relative(repo, file).replace(/\\/g, "/");
  return checkText(fs.readFileSync(file, "utf8"), relative);
}

const key = (finding) => `${finding.file} | ${finding.colour}`;

function main() {
  const files = sourceFiles();
  const findings = files.flatMap(checkFile);
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : { entries: {} };

  if (args.has("--write-baseline")) {
    const entries = {};
    for (const finding of findings) entries[key(finding)] = baseline.entries?.[key(finding)] || "TODO(owner of this file): map to a lawful token (PHILOSOPHY §3.1)";
    const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(
      baselinePath,
      `${JSON.stringify({ $comment: "Palette-law findings that existed when the rule was switched on (WS-KIT). Owners remove their entries; any NEW finding fails `npm run lint:palette`.", entries: sorted }, null, 2)}\n`
    );
    console.log(`check-palette: wrote ${Object.keys(sorted).length} baseline entries.`);
    return;
  }

  const allowed = new Set(Object.keys(baseline.entries || {}));
  const found = new Set(findings.map(key));
  const fresh = findings.filter((finding) => !allowed.has(key(finding)));
  const fixed = [...allowed].filter((entry) => !found.has(entry));

  if (args.has("--prune")) {
    // Drops fixed entries only; never adds (new findings still fail below).
    for (const entry of fixed) delete baseline.entries[entry];
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`check-palette: pruned ${fixed.length} fixed baseline entr${fixed.length === 1 ? "y" : "ies"}.`);
    fixed.length = 0;
  }

  if (args.has("--list")) for (const finding of findings) console.log(`${finding.file}:${finding.line}  ${finding.colour}${allowed.has(key(finding)) ? "  (baseline)" : ""}`);
  if (fixed.length) {
    console.log(`check-palette: ${fixed.length} baseline entr${fixed.length === 1 ? "y is" : "ies are"} fixed; delete from scripts/palette-baseline.json:`);
    for (const entry of fixed) console.log(`  ${entry}`);
  }
  if (fresh.length) {
    console.error("check-palette: only black, greys, whites and golden white (#F3E2B3 family) are allowed (PHILOSOPHY §3.1). New findings:");
    for (const finding of fresh) console.error(`  ${finding.file}:${finding.line}  ${finding.colour}`);
    process.exit(1);
  }
  console.log(`check-palette: ${files.length} files, ${findings.length - fresh.length} baselined findings, 0 new.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

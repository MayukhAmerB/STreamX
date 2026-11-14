#!/usr/bin/env node
// Motion performance rule (UI overhaul plan §2.4), with no dependencies.
// OWNER: WS-A. Fails when a stylesheet transitions or animates a layout or
// paint-heavy property (width, height, margins, insets, flex-basis,
// box-shadow, background-position, filter, `all`, ...). The banned list lives
// in stylelint.config.mjs, so stylelint and this check never disagree.
//
//   node scripts/check-motion.mjs            check src/**/*.{css,scss} + enterprise.css
//   node scripts/check-motion.mjs --list     print every finding, including baselined ones
//
// scripts/motion-baseline.json lists findings that existed when the rule was
// switched on, each owned by a workstream that is removing them. A baselined
// finding that disappears is reported so the entry can be deleted; any NEW
// finding fails the check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BANNED_MOTION_PROPERTIES } from "../stylelint.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const banned = new Set(BANNED_MOTION_PROPERTIES);
const listAll = process.argv.includes("--list");

function walk(directory, out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(target, out);
    } else if (/\.(css|scss)$/.test(entry.name)) out.push(target);
  }
  return out;
}

/** Comments out, line numbers kept. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;{}])\/\/[^\n]*/g, (match, lead) => lead + " ".repeat(match.length - lead.length));
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** First word of each comma-separated transition item (the property). */
function transitionProperties(value) {
  const items = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += char;
  }
  items.push(current);
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const first = item.split(/\s+/)[0];
      // `transition: 200ms` (no property) means `all`.
      if (/^[\d.]+m?s$/.test(first) || /^var\(--[\w-]*(duration|ease)/.test(first)) return "all";
      return first.toLowerCase();
    });
}

/** Body of the block that opens at `open` (index of "{"). */
function blockBody(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

function check(file) {
  const text = stripComments(fs.readFileSync(file, "utf8"));
  const findings = [];
  const relative = path.relative(repo, file).replace(/\\/g, "/");

  for (const match of text.matchAll(/(?:^|[\s;{])(transition(?:-property)?)\s*:\s*([^;{}]+)/g)) {
    const value = match[2].trim();
    if (/^(none|initial|inherit|unset)$/i.test(value)) continue;
    // Sass interpolation or a whole-variable value cannot be read statically.
    if (/^\$|^#\{/.test(value)) continue;
    for (const property of transitionProperties(value)) {
      if (banned.has(property)) findings.push({ file: relative, line: lineOf(text, match.index), kind: "transition", property });
    }
  }

  for (const match of text.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const body = blockBody(text, match.index + match[0].length - 1);
    for (const declaration of body.matchAll(/(?:^|[\s;{])([a-z-]+)\s*:/g)) {
      const property = declaration[1].toLowerCase();
      if (banned.has(property)) findings.push({ file: relative, line: lineOf(text, match.index), kind: `@keyframes ${match[1]}`, property });
    }
  }
  return findings;
}

const files = [...walk(path.join(root, "src")), path.join(repo, "backend/apps/users/static/admin/css/enterprise.css")].filter((file) => fs.existsSync(file));
const findings = files.flatMap(check);
const key = (finding) => `${finding.file} | ${finding.kind} | ${finding.property}`;

const baselinePath = path.join(root, "scripts/motion-baseline.json");
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : { entries: {} };
const allowed = new Set(Object.keys(baseline.entries || {}));
const found = new Set(findings.map(key));

const fresh = findings.filter((finding) => !allowed.has(key(finding)));
const fixed = [...allowed].filter((entry) => !found.has(entry));

if (listAll) for (const finding of findings) console.log(`${finding.file}:${finding.line}  ${finding.kind} animates ${finding.property}${allowed.has(key(finding)) ? "  (baseline)" : ""}`);
if (fixed.length) {
  console.log(`check-motion: ${fixed.length} baseline entr${fixed.length === 1 ? "y is" : "ies are"} fixed; delete from scripts/motion-baseline.json:`);
  for (const entry of fixed) console.log(`  ${entry}`);
}
if (fresh.length) {
  console.error("check-motion: animate only transform and opacity (UI overhaul §2.4). New findings:");
  for (const finding of fresh) console.error(`  ${finding.file}:${finding.line}  ${finding.kind} animates ${finding.property}`);
  process.exit(1);
}
console.log(`check-motion: ${files.length} stylesheets, ${findings.length - fresh.length} baselined, 0 new findings.`);

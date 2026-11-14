#!/usr/bin/env node
// Copies the self-hosted fonts for the labs site from the frontend's installed
// Fontsource packages (SIL Open Font License) into OSINTCTF/fonts/.
//
//   node OSINTCTF/scripts/copy-fonts.mjs        (run after `npm ci` in frontend/)
//
// The labs site is a separate Docker image (build context OSINTCTF/), so the
// woff2 files are checked in next to it and served by server.js under /fonts/.
// Latin subsets only: Urdu text uses the system Nastaliq/Naskh stack.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const labsRoot = path.resolve(here, "..");
const modules = path.resolve(labsRoot, "..", "frontend", "node_modules");

const FONTS = [
    {
        pkg: "@fontsource-variable/geist",
        dir: "geist",
        files: ["geist-latin-wght-normal.woff2"],
    },
    {
        pkg: "@fontsource-variable/geist-mono",
        dir: "geist-mono",
        files: ["geist-mono-latin-wght-normal.woff2"],
    },
    {
        pkg: "@fontsource/handlee",
        dir: "handlee",
        files: ["handlee-latin-400-normal.woff2"],
    },
];

let copied = 0;
for (const font of FONTS) {
    const source = path.join(modules, ...font.pkg.split("/"));
    if (!existsSync(source)) {
        console.error(`Missing ${font.pkg}. Run "npm ci" in frontend/ first.`);
        process.exit(1);
    }
    const target = path.join(labsRoot, "fonts", font.dir);
    mkdirSync(target, { recursive: true });
    for (const file of font.files) {
        copyFileSync(path.join(source, "files", file), path.join(target, file));
        copied += 1;
    }
    copyFileSync(path.join(source, "LICENSE"), path.join(target, "OFL.txt"));
}
console.log(`Copied ${copied} font files into ${path.join(labsRoot, "fonts")}`);

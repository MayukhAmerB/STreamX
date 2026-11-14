// Guard for every Carbon notification in the app: InlineNotification and
// ToastNotification throw "component should have no interactive child nodes"
// (in the production build too) when a button, link or input is rendered
// inside them (children, title, subtitle or caption), and Callout throws for
// interactive children without aria-describedby. That error blanked the
// weekly report page after Submit (E2E run-02). Put actions BESIDE the
// notification (PageNotification's actionLabel, NoticeWithActions) or use
// ActionableNotification.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECKED = ["InlineNotification", "ToastNotification", "Callout"];
const INTERACTIVE = /<(Button|IconButton|button|a|Link|NavLink|input|select|textarea|TextInput|TextArea|Select|Checkbox|Toggle|Search|OverflowMenu)\b|\bonClick=|\bhref=|tabIndex=\{?["']?0/;

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__contracts__") sources(target, out);
    } else if (/\.(jsx|tsx|js|ts)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name)) {
      out.push(target);
    }
  }
  return out;
}

/** End index of a JSX opening tag starting at `start`, skipping {...} and strings. */
function openingTagEnd(text, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote && text[index - 1] !== "\\") quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index;
  }
  return text.length - 1;
}

/** Every checked notification whose JSX content (children or text props) is interactive. */
export function findInteractiveNotifications(text, file = "<inline>") {
  const problems = [];
  const opener = new RegExp(`<(${CHECKED.join("|")})\\b`, "g");
  let match;
  while ((match = opener.exec(text))) {
    const end = openingTagEnd(text, match.index + match[0].length);
    const tag = text.slice(match.index, end + 1);
    const selfClosing = tag.endsWith("/>");
    const body = selfClosing ? "" : text.slice(end + 1, Math.max(end + 1, text.indexOf(`</${match[1]}>`, end)));
    const textProps = (tag.match(/\b(title|subtitle|caption)=\{[\s\S]*?\}(?=\s+\w+=|\s*\/?>)/g) || []).join(" ");
    const callout = match[1] === "Callout";
    if (INTERACTIVE.test(textProps) || (!callout && INTERACTIVE.test(body)) || (callout && INTERACTIVE.test(body) && !/aria-describedby/.test(body))) {
      problems.push(`${file}:${text.slice(0, match.index).split("\n").length} <${match[1]}> has interactive content`);
    }
  }
  return problems;
}

describe("Carbon notifications never contain interactive children", () => {
  it("detects the pattern that crashed the weekly report", () => {
    const crashing = `<InlineNotification kind="success" title="Report submitted.">
        <Button kind="ghost" onClick={onUndo}>Undo</Button>
      </InlineNotification>`;
    expect(findInteractiveNotifications(crashing)).toHaveLength(1);
    expect(findInteractiveNotifications(`<InlineNotification title={<span>Hi <Link to="/x">open</Link></span>} />`)).toHaveLength(1);
    expect(findInteractiveNotifications(`<InlineNotification title="Ok" subtitle={error} />`)).toEqual([]);
    expect(findInteractiveNotifications(`<InlineNotification title="Bad files"><ul><li>a.exe</li></ul></InlineNotification>`)).toEqual([]);
  });

  it("holds for every report, exam, upload and other screen in src/", () => {
    const problems = sources(SRC).flatMap((file) => findInteractiveNotifications(fs.readFileSync(file, "utf8"), path.relative(SRC, file)));
    expect(problems).toEqual([]);
  });
});

// Pure helpers for the profile editor and page. OWNER: WS-PROFILES.
// The server is the authority (it rebuilds every document); these helpers
// only shape the editor state and turn server findings into readable text.

export const BLOCK_TYPES = ["bio", "badges", "skills", "writeups", "gallery", "links"];

export const BLOCK_META = {
  bio: { label: "About", hint: "A few lines about what you study and enjoy." },
  badges: { label: "Badges", hint: "Show up to 8 badges you have earned." },
  skills: { label: "Skills", hint: "What you are learning, practising or confident in." },
  writeups: { label: "Write-ups", hint: "Your solved cases and notes, with a link." },
  gallery: { label: "Gallery", hint: "Screenshots of your work. Hidden details are removed on upload." },
  links: { label: "Links", hint: "Up to 8 https links (GitHub, blog, portfolio)." },
};

/** Skill levels: status is icon + word, never colour (palette law). */
export const SKILL_LEVELS = [
  { value: "learning", label: "Learning", icon: "circle" },
  { value: "practising", label: "Practising", icon: "half" },
  { value: "confident", label: "Confident", icon: "check" },
];

export const REPORT_REASONS = [
  { value: "personal_info", label: "Shares personal information" },
  { value: "harassment", label: "Harassment or hate" },
  { value: "impersonation", label: "Pretends to be someone else" },
  { value: "inappropriate", label: "Inappropriate images or text" },
  { value: "spam", label: "Spam or scam links" },
  { value: "other", label: "Something else" },
];

export const EMPTY_BLOCKS = {
  bio: { source: "" },
  badges: { badge_keys: [] },
  skills: { items: [] },
  writeups: { items: [] },
  gallery: { items: [] },
  links: { items: [] },
};

/** A block of `type` with its empty fields. */
export function newBlock(type) {
  return { id: type, type, visible: true, title: "", ...structuredCloneSafe(EMPTY_BLOCKS[type] || {}) };
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Types not yet on the page (the "Add a block" menu). */
export function missingBlockTypes(blocks = []) {
  const present = new Set(blocks.map((block) => block.type));
  return BLOCK_TYPES.filter((type) => !present.has(type));
}

/** Move the block at `index` by `delta` (-1 up, +1 down); returns a new array. */
export function moveBlock(blocks, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= blocks.length || target < 0 || target >= blocks.length) return blocks;
  const next = blocks.slice();
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function updateBlock(blocks, index, patch) {
  return blocks.map((block, position) => (position === index ? { ...block, ...patch } : block));
}

export function removeBlock(blocks, index) {
  return blocks.filter((_, position) => position !== index);
}

/** The document the API expects from editor state (drops UI-only keys). */
export function toDocument(draft) {
  const header = draft?.header || {};
  return {
    v: 1,
    theme: { ...(draft?.theme || {}) },
    header: {
      display_name: header.display_name || "",
      tagline: header.tagline || "",
      avatar_id: header.avatar_id || null,
      banner_id: header.banner_id || null,
    },
    blocks: (draft?.blocks || []).map((block) => {
      const { doc: _doc, ...rest } = block;
      if (rest.type === "writeups" || rest.type === "links") {
        rest.items = (rest.items || []).map(({ host: _host, ...item }) => item);
      }
      return rest;
    }),
  };
}

const FIELD_LABELS = {
  "header.display_name": "Display name",
  "header.tagline": "Tagline",
  source: "About text",
  title: "Section title",
  name: "Skill",
  summary: "Summary",
  url: "Link",
  label: "Link label",
  caption: "Caption",
  alt: "Image description",
  tags: "Tag",
};

/**
 * "blocks[2].items[0].summary" -> "Write-ups, item 1: Summary" (uses the
 * draft to name the block). Image metadata paths read "Image details".
 */
export function describePath(path, draft) {
  const text = String(path || "");
  if (FIELD_LABELS[text]) return FIELD_LABELS[text];
  if (text.startsWith("image.metadata")) return "Image details (metadata)";
  if (text === "handle") return "Handle";
  const match = text.match(/^blocks\[(\d+)\](?:\.items\[(\d+)\])?\.?([a-z_]+)?(?:\[(\d+)\])?/);
  if (!match) return text;
  const block = draft?.blocks?.[Number(match[1])];
  const blockLabel = block ? block.title || BLOCK_META[block.type]?.label || block.type : "Section";
  const parts = [blockLabel];
  if (match[2] !== undefined) parts.push(`item ${Number(match[2]) + 1}`);
  const field = FIELD_LABELS[match[3]] || "";
  return field ? `${parts.join(", ")}: ${field}` : parts.join(", ");
}

/** Group findings for the notice: one row per field with the labels found there. */
export function groupFindings(findings = [], draft) {
  const rows = new Map();
  for (const finding of findings) {
    const key = finding.path || "";
    if (!rows.has(key)) rows.set(key, { path: key, where: describePath(key, draft), labels: [], excerpts: [] });
    const row = rows.get(key);
    if (!row.labels.includes(finding.label)) row.labels.push(finding.label);
    if (finding.excerpt && !row.excerpts.includes(finding.excerpt)) row.excerpts.push(finding.excerpt);
  }
  return [...rows.values()];
}

/** True when `path` (a finding path) belongs to the field at `prefix`. */
export function pathHasFinding(findings = [], prefix) {
  return findings.some((finding) => finding.path === prefix || String(finding.path || "").startsWith(`${prefix}.`) || String(finding.path || "").startsWith(`${prefix}[`));
}

/** Markdown helpers for the bio toolbar (the server parses the subset). */
export function wrapSelection(value, start, end, before, after = before, placeholder = "text") {
  const selected = value.slice(start, end) || placeholder;
  const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
  return { value: next, start: start + before.length, end: start + before.length + selected.length };
}

export function prefixLines(value, start, end, prefix) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const block = value.slice(lineStart, end) || "";
  const prefixed = block
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`))
    .join("\n");
  const next = `${value.slice(0, lineStart)}${prefixed}${value.slice(end)}`;
  return { value: next, start: lineStart, end: lineStart + prefixed.length };
}

export function initialsOf(text) {
  const words = String(text || "").replace(/[_.-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return (words[0]?.[0] || "?").toUpperCase() + (words[1]?.[0] || "").toUpperCase();
}

export function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

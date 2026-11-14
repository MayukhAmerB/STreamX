// Pure model of the Ctrl/Cmd+K palette (UI overhaul plan §4.5). OWNER: WS-G.
// No React here: tasks, destinations, matching, highlighting and the
// "recent" list (browser storage, always optional).
import { getNavItems } from "../app-shell/navConfig";
import { ADMIN_DESTINATIONS, ADMIN_TASKS } from "../admin/adminSitemap";

export const MIN_RECORD_QUERY = 2;
export const RECENT_LIMIT = 5;
export const SECTION_LIMIT_EMPTY = 6;
export const SECTION_LIMIT = 8;
export const TASK_LIMIT = 6;
const RECENT_KEY = "sc-palette-recent-v1";

/** `/admin/...` and absolute URLs are full page loads; everything else is the SPA. */
export function isDocumentHref(href = "") {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href) || href === "/admin" || href.startsWith("/admin/");
}

export function normalise(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Score an item for a query: 0 = no match; higher is better. */
export function matchScore(item, query) {
  const q = normalise(query);
  if (!q) return 1;
  const title = normalise(item.title);
  const haystack = `${title} ${normalise(item.subtitle)} ${normalise((item.keywords || []).join(" "))}`;
  const tokens = q.split(" ");
  if (!tokens.every((token) => haystack.includes(token))) return 0;
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.split(" ").some((word) => word.startsWith(tokens[0]))) return 60;
  if (title.includes(q)) return 40;
  return 20;
}

export function filterItems(items, query, limit) {
  const scored = items
    .map((item, index) => ({ item, index, score: matchScore(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
  return typeof limit === "number" ? scored.slice(0, limit) : scored;
}

/**
 * Splits `text` around the first match of `query` (whole query first, then
 * its first word) for the 600-weight highlight. Returns [{text, match}].
 */
export function highlightParts(text = "", query = "") {
  const value = String(text || "");
  const q = String(query || "").trim();
  if (!q) return [{ text: value, match: false }];
  const lower = value.toLowerCase();
  let needle = q.toLowerCase();
  let at = lower.indexOf(needle);
  if (at < 0) {
    needle = needle.split(/\s+/)[0];
    at = needle ? lower.indexOf(needle) : -1;
  }
  if (at < 0) return [{ text: value, match: false }];
  const parts = [];
  if (at > 0) parts.push({ text: value.slice(0, at), match: false });
  parts.push({ text: value.slice(at, at + needle.length), match: true });
  if (at + needle.length < value.length) parts.push({ text: value.slice(at + needle.length), match: false });
  return parts;
}

/** Tasks the viewer may run (staff only today: every task is an admin job). */
export function buildTasks({ isAdmin = false } = {}) {
  if (!isAdmin) return [];
  return ADMIN_TASKS.map((task) => ({ ...task, kind: "task", id: `task:${task.key}` }));
}

/** Every page the viewer can open: their Console nav plus, for staff, the admin map. */
export function buildDestinations(auth = {}) {
  let navItems = [];
  try {
    navItems = getNavItems(auth) || [];
  } catch {
    navItems = [];
  }
  const seen = new Set();
  const out = [];
  const push = (item) => {
    if (!item.href || seen.has(item.href)) return;
    seen.add(item.href);
    out.push(item);
  };
  if (auth?.isAdmin) {
    ADMIN_DESTINATIONS.forEach((dest) =>
      push({ ...dest, kind: "section", id: `section:${dest.href}`, subtitle: dest.group })
    );
  }
  navItems.forEach((item) => {
    const href = item.external ? item.href : item.to;
    if (!href || item.state === "hidden") return;
    push({
      kind: "section",
      id: `section:${href}`,
      title: item.label,
      subtitle: item.hint || "",
      href,
      external: Boolean(item.external),
      keywords: [item.shortLabel].filter(Boolean),
    });
  });
  return out;
}

/** Records from GET /api/admin/search/ → palette groups. */
export function recordGroups(payload) {
  return (payload?.groups || [])
    .filter((group) => group?.items?.length)
    .map((group) => ({
      key: `record:${group.key}`,
      label: group.label,
      items: group.items.map((item) => ({ ...item, kind: "record", id: `record:${item.id}`, recordId: item.id })),
    }));
}

/**
 * The visible groups for a query, in display order: Recent (empty query),
 * Tasks, one group per record type, Sections. Each group: {key, label, items}.
 */
export function buildGroups({ query = "", tasks = [], destinations = [], records = [], recent = [] }) {
  const q = query.trim();
  const groups = [];
  if (!q && recent.length) groups.push({ key: "recent", label: "Recent", items: recent });
  const taskItems = filterItems(tasks, q, TASK_LIMIT);
  if (taskItems.length) groups.push({ key: "tasks", label: "Tasks", items: taskItems });
  if (q) groups.push(...records);
  const sections = filterItems(destinations, q, q ? SECTION_LIMIT : SECTION_LIMIT_EMPTY);
  if (sections.length) groups.push({ key: "sections", label: q ? "Sections" : "Go to", items: sections });
  return groups;
}

export function flatten(groups) {
  return groups.flatMap((group) => group.items);
}

function storageKey(userId) {
  return `${RECENT_KEY}:${userId ?? "anon"}`;
}

export function readRecent(userId, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.href === "string" && typeof item.title === "string").slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecent(userId, item, storage = globalThis.localStorage) {
  const entry = {
    id: `recent:${item.href}`,
    kind: item.kind === "record" ? "record" : item.kind,
    title: item.title,
    subtitle: item.subtitle || "",
    href: item.href,
  };
  const next = [entry, ...readRecent(userId, storage).filter((existing) => existing.href !== item.href)].slice(0, RECENT_LIMIT);
  try {
    storage?.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: the palette works without recents.
  }
  return next;
}

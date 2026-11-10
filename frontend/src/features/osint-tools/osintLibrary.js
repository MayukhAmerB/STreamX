// Pure search/filter model for the OSINT tools library (no React, no Carbon).
import { allToolCount, beginnerPaths, categoryByTitle, toolCategories } from "./osintToolsData";

export { allToolCount, toolCategories };

export const ALL_CLUES = "all";

/** Short, plain chip labels for each beginner lane (keyed by lane title). */
const CLUE_LABELS = {
  "Username Or Email": "Username or email",
  "Domain Or URL": "Domain or URL",
  "Phone Or Vehicle": "Phone or vehicle",
  "Image Or Screenshot": "Image or screenshot",
  "File Or Metadata": "File or metadata",
  "Older Web Evidence": "Older web pages",
  "Writing Or Behavior": "Writing or behavior",
  "Authorized Phishing Lab": "Phishing lab",
  "I Am Not Sure Yet": "Not sure yet",
};

/** Chip labels for categories that have no beginner lane (keyed by category title). */
const CATEGORY_LABELS = {
  "Enterprise OSINT And Threat Platforms": "Threat platforms",
};

const slug = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** "Enterprise OSINT And Threat Platforms" -> "Enterprise OSINT and threat platforms". */
export function toSentenceCase(title = "") {
  return String(title)
    .split(" ")
    .map((word, index) => {
      if (index === 0) return word;
      const letters = word.replace(/[^A-Za-z]/g, "");
      if (letters.length > 1 && letters === letters.toUpperCase()) return word; // acronym
      return word.toLowerCase();
    })
    .join(" ");
}

/**
 * "What clue do you have?" filters: every beginner lane (in its original
 * order) plus categories no lane points at, with "Not sure yet" kept last.
 */
export const CLUE_FILTERS = (() => {
  const lanes = beginnerPaths.map((path) => ({
    id: slug(path.title),
    label: CLUE_LABELS[path.title] || toSentenceCase(path.title),
    prompt: path.prompt,
    start: path.start,
    categoryTitle: path.categoryTitle,
  }));
  const covered = new Set(lanes.map((lane) => lane.categoryTitle));
  const extras = toolCategories
    .filter((category) => !covered.has(category.title))
    .map((category) => ({
      id: slug(category.title),
      label: CATEGORY_LABELS[category.title] || toSentenceCase(category.title),
      prompt: category.focus,
      start: "",
      categoryTitle: category.title,
    }));
  const unsureIndex = lanes.findIndex((lane) => lane.id === "i-am-not-sure-yet");
  if (unsureIndex < 0) return [...lanes, ...extras];
  return [...lanes.slice(0, unsureIndex), ...extras, ...lanes.slice(unsureIndex)];
})();

export function getClueFilter(clueId) {
  return CLUE_FILTERS.find((clue) => clue.id === clueId) || null;
}

export function getCategory(title) {
  return categoryByTitle.get(title) || null;
}

function toolMatches(tool, category, terms) {
  if (!terms.length) return true;
  const haystack = [tool.name, tool.type, tool.use, category.title].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Tools grouped by category for the current clue filter and search text.
 * Every search word must match the tool's name, type, description or
 * category. Categories with no matching tools are dropped.
 */
export function filterToolGroups({ clueId = ALL_CLUES, query = "" } = {}) {
  const clue = clueId === ALL_CLUES ? null : getClueFilter(clueId);
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return toolCategories
    .filter((category) => !clue || category.title === clue.categoryTitle)
    .map((category) => ({
      category,
      title: toSentenceCase(category.title),
      tools: category.tools.filter((tool) => toolMatches(tool, category, terms)),
    }))
    .filter((group) => group.tools.length > 0);
}

export function countTools(groups = []) {
  return groups.reduce((total, group) => total + group.tools.length, 0);
}

// Parser for Obsidian canvases (JSON Canvas, https://jsoncanvas.org) into a
// normalised, render-ready layout for the read-only SVG preview.

export const CANVAS_MAX_ITEMS = 2000;
const DEFAULT_WIDTH = 250;
const DEFAULT_HEIGHT = 60;
const NODE_TYPES = new Set(["text", "file", "link", "group"]);
const SIDES = new Set(["top", "right", "bottom", "left"]);
// Obsidian's preset colours "1"…"6".
export const CANVAS_PRESET_COLORS = {
  1: "#fb464c",
  2: "#e9973f",
  3: "#e0de71",
  4: "#44cf6e",
  5: "#53dfdd",
  6: "#a882ff",
};

function finite(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function resolveCanvasColor(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (CANVAS_PRESET_COLORS[text]) return CANVAS_PRESET_COLORS[text];
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text) ? text : "";
}

/** Plain text of a card: Markdown markers stripped, for SVG <text>. */
export function plainCardText(text = "") {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => alias || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Pair markers only: a single "_" stays (handles such as @ql247_help).
    .replace(/\*\*|__|~~|==|`/g, "")
    .replace(/\*(?!\s)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .trim();
}

/** Greedy word wrap into at most `maxLines` lines of `maxChars`. */
export function wrapText(text, maxChars, maxLines) {
  const limit = Math.max(4, Math.floor(maxChars));
  const lines = [];
  String(text || "")
    .split("\n")
    .forEach((paragraph) => {
      let line = "";
      paragraph.split(/\s+/).forEach((word) => {
        if (!word) return;
        const chunks = word.length > limit ? word.match(new RegExp(`.{1,${limit}}`, "g")) : [word];
        chunks.forEach((chunk) => {
          if (!line) line = chunk;
          else if (`${line} ${chunk}`.length <= limit) line = `${line} ${chunk}`;
          else {
            lines.push(line);
            line = chunk;
          }
        });
      });
      lines.push(line);
    });
  const trimmed = lines.filter((value, index) => value || index < lines.length - 1);
  if (trimmed.length <= maxLines) return trimmed;
  const kept = trimmed.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(0, limit - 1))}…`;
  return kept;
}

function nodeLabel(node) {
  if (node.type === "text") return plainCardText(node.text);
  if (node.type === "file") return String(node.file || "").split("/").pop() || "File";
  if (node.type === "link") return String(node.url || "Link");
  return String(node.label || "");
}

function anchor(node, side) {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    default:
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

/** Side of `from` facing `to` (used when an edge has no side). */
export function facingSide(from, to) {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

const SIDE_VECTORS = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

/** Cubic path between two anchors, bulging out of each side like Obsidian. */
export function edgePath(start, startSide, end, endSide) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const bend = Math.min(160, Math.max(30, distance / 2.5));
  const [sx, sy] = SIDE_VECTORS[startSide];
  const [ex, ey] = SIDE_VECTORS[endSide];
  const c1 = { x: start.x + sx * bend, y: start.y + sy * bend };
  const c2 = { x: end.x + ex * bend, y: end.y + ey * bend };
  const round = (value) => Math.round(value * 10) / 10;
  return `M ${round(start.x)} ${round(start.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(end.x)} ${round(end.y)}`;
}

/**
 * Parses canvas JSON (string or object). Returns
 * { nodes, edges, bounds, truncated, error }. Never throws.
 */
export function parseCanvas(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = input.trim() ? JSON.parse(input) : {};
    } catch {
      return { nodes: [], edges: [], bounds: null, truncated: false, error: "This canvas file is not valid JSON." };
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { nodes: [], edges: [], bounds: null, truncated: false, error: "This file is not an Obsidian canvas." };
  }
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];
  const truncated = rawNodes.length + rawEdges.length > CANVAS_MAX_ITEMS;

  const nodes = [];
  const byId = new Map();
  rawNodes.slice(0, CANVAS_MAX_ITEMS).forEach((raw) => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || byId.has(raw.id)) return;
    const node = {
      id: raw.id,
      type: NODE_TYPES.has(raw.type) ? raw.type : "text",
      x: finite(raw.x, 0),
      y: finite(raw.y, 0),
      width: Math.max(20, finite(raw.width, DEFAULT_WIDTH)),
      height: Math.max(20, finite(raw.height, DEFAULT_HEIGHT)),
      color: resolveCanvasColor(raw.color),
      text: typeof raw.text === "string" ? raw.text : "",
      file: typeof raw.file === "string" ? raw.file : "",
      url: typeof raw.url === "string" ? raw.url : "",
      label: typeof raw.label === "string" ? raw.label : "",
    };
    node.display = nodeLabel(node);
    nodes.push(node);
    byId.set(node.id, node);
  });

  const edges = [];
  rawEdges.slice(0, Math.max(0, CANVAS_MAX_ITEMS - nodes.length)).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const from = byId.get(raw.fromNode);
    const to = byId.get(raw.toNode);
    if (!from || !to) return;
    const fromSide = SIDES.has(raw.fromSide) ? raw.fromSide : facingSide(from, to);
    const toSide = SIDES.has(raw.toSide) ? raw.toSide : facingSide(to, from);
    const start = anchor(from, fromSide);
    const end = anchor(to, toSide);
    edges.push({
      id: typeof raw.id === "string" ? raw.id : `edge-${index}`,
      from: from.id,
      to: to.id,
      fromSide,
      toSide,
      start,
      end,
      path: edgePath(start, fromSide, end, toSide),
      label: typeof raw.label === "string" ? raw.label : "",
      color: resolveCanvasColor(raw.color),
      arrowStart: raw.fromEnd === "arrow",
      arrowEnd: raw.toEnd !== "none",
    });
  });

  let bounds = null;
  if (nodes.length) {
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
    bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  // Groups are drawn first so cards sit on top of them.
  nodes.sort((a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1));
  return { nodes, edges, bounds, truncated, error: "" };
}

/** Initial viewBox: the canvas bounds plus a margin, never degenerate. */
export function initialViewBox(bounds, margin = 40) {
  if (!bounds) return { x: 0, y: 0, width: 400, height: 300 };
  return {
    x: bounds.x - margin,
    y: bounds.y - margin,
    width: Math.max(200, bounds.width + margin * 2),
    height: Math.max(150, bounds.height + margin * 2),
  };
}

/** Zoom a viewBox around its centre (factor < 1 zooms in). */
export function zoomViewBox(view, factor) {
  const width = Math.min(200000, Math.max(50, view.width * factor));
  const height = Math.min(200000, Math.max(40, view.height * factor));
  return {
    x: view.x + (view.width - width) / 2,
    y: view.y + (view.height - height) / 2,
    width,
    height,
  };
}

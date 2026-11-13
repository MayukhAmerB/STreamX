// Link-parity contract helpers (plan §7.3): turn a rendered host tree
// (test-utils/renderTree) into a stable inventory of every href, button
// label and named anchor, and compare it with the committed fixture.
//
// Rules enforced by compareInventory():
// - an href, route or required anchor that existed in the fixture may never
//   disappear;
// - a new href or route is accepted only when it is on the fixture's
//   explicit allowlist for that surface;
// - a button label may only disappear when the fixture maps it to a new
//   label in `renamedButtons` and that new label is rendered.

const GENERATED_ID = /[:«»]/; // React useId values (":r1:" / "«r1»") are not anchors.

function walk(node, visit, { skip } = {}) {
  if (!node) return;
  if (node.type) {
    if (skip && skip(node)) return;
    visit(node);
  }
  (node.children || []).forEach((child) => walk(child, visit, { skip }));
}

export function textOfNode(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.children || []).map(textOfNode).join("");
}

export function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** Accessible name used for buttons: aria-label wins, else the visible text. */
export function accessibleLabel(node) {
  return normalizeLabel(node?.props?.["aria-label"] || textOfNode(node));
}

const isButton = (node) => node.type === "button" || node.props?.role === "button";

/** Collects one surface's inventory. `skip` prunes subtrees (e.g. the open sheet). */
export function collectInventory(root, { skip } = {}) {
  const hrefs = new Set();
  const buttons = new Set();
  const anchors = new Set();
  walk(
    root,
    (node) => {
      const props = node.props || {};
      if (node.type === "a" && typeof props.href === "string" && props.href) hrefs.add(props.href);
      if (isButton(node)) {
        const label = accessibleLabel(node);
        if (label) buttons.add(label);
      }
      if (typeof props.id === "string" && props.id && !GENERATED_ID.test(props.id)) anchors.add(props.id);
    },
    { skip }
  );
  const sorted = (set) => [...set].sort();
  return { hrefs: sorted(hrefs), buttons: sorted(buttons), anchors: sorted(anchors) };
}

/** Every `path=` declared in AppRoutes.jsx (string literal or expression), in source order, unique. */
export function parseRoutePaths(source) {
  const found = [];
  const pattern = /\bpath=(?:"([^"]+)"|\{`([^`]+)`\}|\{([^}]+)\})/g;
  let match;
  while ((match = pattern.exec(String(source || "")))) {
    const value = (match[1] || match[2] || match[3] || "").trim();
    if (value && !found.includes(value)) found.push(value);
  }
  return found;
}

function missing(expected = [], actual = []) {
  const have = new Set(actual);
  return expected.filter((item) => !have.has(item));
}

/**
 * Compares one surface. Returns a list of human-readable problems ([] = parity).
 * `allowedHrefAdditions` / `renamedButtons` / `requiredAnchors` come from the fixture.
 */
export function compareSurface(name, expected, actual, { allowedHrefAdditions = [], renamedButtons = {}, requiredAnchors = [] } = {}) {
  const problems = [];
  missing(expected.hrefs, actual.hrefs).forEach((href) => problems.push(`${name}: href removed: ${href}`));
  const known = new Set([...(expected.hrefs || []), ...allowedHrefAdditions]);
  (actual.hrefs || [])
    .filter((href) => !known.has(href))
    .forEach((href) => problems.push(`${name}: href added without allowlist entry: ${href}`));

  missing(expected.buttons, actual.buttons).forEach((label) => {
    const renamedTo = renamedButtons[label];
    if (renamedTo && (actual.buttons || []).includes(renamedTo)) return;
    problems.push(
      renamedTo
        ? `${name}: button "${label}" was renamed to "${renamedTo}" in the fixture, but "${renamedTo}" is not rendered`
        : `${name}: button label removed: "${label}"`
    );
  });

  missing(requiredAnchors, actual.anchors).forEach((id) => problems.push(`${name}: anchor removed: #${id}`));
  return problems;
}

/** Routes: none may disappear; additions only from the allowlist. */
export function compareRoutes(expected = [], actual = [], allowedAdditions = []) {
  const problems = missing(expected, actual).map((route) => `routes: route removed: ${route}`);
  const known = new Set([...expected, ...allowedAdditions]);
  actual.filter((route) => !known.has(route)).forEach((route) => problems.push(`routes: route added without allowlist entry: ${route}`));
  return problems;
}

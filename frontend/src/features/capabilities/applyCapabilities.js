// Pure capability resolution for nav items (UI overhaul plan §5.4, Appendix A.5).
// OWNER: WS-F (stub created by WS-0 with the final signature).
//
//   applyCapabilities(items, caps) -> items[{ ...item, state, reason }]
//
// An item is gated when it names a capability key (`item.capability`, e.g.
// "teach-courses"), a workspace (`item.workspace`, e.g. "teach") or a
// feature (`item.feature`, e.g. "teaching"). Ungated items are always
// "enabled". Before capabilities load (`caps` null) a gated item is
// "disabled" with the reason "Checking…" so it never flashes enabled.

export const CAPABILITY_STATES = Object.freeze(["enabled", "disabled", "hidden"]);
export const CHECKING_REASON = "Checking…";

function entryState(entry) {
  if (!entry || !CAPABILITY_STATES.includes(entry.state)) {
    return null;
  }
  return { state: entry.state, reason: entry.state === "disabled" ? entry.reason || "" : "" };
}

/** Resolves one item against `caps`; returns `{ state, reason }`. */
export function resolveCapability(item, caps) {
  const gated = Boolean(item?.capability || item?.workspace || item?.feature);
  if (!gated) {
    return { state: "enabled", reason: "" };
  }
  if (!caps) {
    return { state: "disabled", reason: CHECKING_REASON };
  }
  const fromItem = item.capability ? entryState(caps.items?.[item.capability]) : null;
  if (fromItem) {
    return fromItem;
  }
  const fromWorkspace = item.workspace ? entryState(caps.workspaces?.[item.workspace]) : null;
  if (fromWorkspace) {
    return fromWorkspace;
  }
  if (item.feature) {
    const enabled = Boolean(caps.features?.[item.feature]?.enabled);
    return enabled ? { state: "enabled", reason: "" } : { state: "disabled", reason: item.disabledReason || "" };
  }
  return { state: "enabled", reason: "" };
}

/** Annotates each item with `state` and `reason`. Never drops items: callers hide `state === "hidden"`. */
export default function applyCapabilities(items = [], caps = null) {
  return (items || []).map((item) => ({ ...item, ...resolveCapability(item, caps) }));
}

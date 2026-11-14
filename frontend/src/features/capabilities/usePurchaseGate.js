// usePurchaseGate(courseOrPlan) -> { state, reason, code, disabled }
// (contract hackpath/contracts/catalog.md §7). The UI disables, never hides,
// a buy / enrol / subscribe control and shows `reason` next to it. Sources, in
// order: the object's own gate (course `purchase_gate` / catalogue card
// `purchase` / plan `state`), then — for Pentesting courses and plans — the
// capabilities item "pentesting-purchase". The server enforces the same rule
// (403 feature_disabled), so this is only the early, calm answer.
import { useMemo } from "react";

import useCapabilities from "./useCapabilities";

export const PURCHASE_STATES = Object.freeze({
  AVAILABLE: "available",
  COMING_SOON: "coming_soon",
  UNAVAILABLE: "unavailable",
});

const PENTESTING_REASON = "Pentesting is coming soon. You can browse every course now; enrolment opens at launch.";

const text = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

function isPentesting(subject) {
  return subject?.category === "web_pentesting" || subject?.track === "web_pentesting" || subject?.group === "pentesting";
}

function result(state, reason = "", code = "") {
  const known = Object.values(PURCHASE_STATES).includes(state) ? state : PURCHASE_STATES.UNAVAILABLE;
  return { state: known, reason: known === PURCHASE_STATES.AVAILABLE ? "" : text(reason), code: text(code), disabled: known !== PURCHASE_STATES.AVAILABLE };
}

/** Pure resolver (unit-tested); `caps` is the capabilities payload or null. */
export function resolvePurchaseGate(subject, caps = null) {
  if (!subject || typeof subject !== "object") return result(PURCHASE_STATES.UNAVAILABLE);
  const own = subject.purchase_gate || subject.purchase;
  const capItem = caps?.items?.["pentesting-purchase"];
  if (isPentesting(subject) && capItem?.state === "disabled") {
    return result(PURCHASE_STATES.COMING_SOON, capItem.reason || PENTESTING_REASON, "feature_disabled");
  }
  if (own && typeof own === "object" && own.state) return result(own.state, own.reason, own.code);
  if (typeof subject.state === "string" && "key" in subject) return result(subject.state, subject.reason, subject.code);
  if (subject.purchase_available === true) return result(PURCHASE_STATES.AVAILABLE);
  if (subject.purchase_available === false) {
    const code = text(subject.purchase_unavailable_reason);
    const comingSoon = code === "feature_disabled" || code === "course_not_live";
    return result(comingSoon ? PURCHASE_STATES.COMING_SOON : PURCHASE_STATES.UNAVAILABLE,
      code === "feature_disabled" ? PENTESTING_REASON : "", code);
  }
  if (isPentesting(subject) && capItem?.state !== "enabled") {
    return result(PURCHASE_STATES.COMING_SOON, PENTESTING_REASON, "feature_disabled");
  }
  return result(PURCHASE_STATES.AVAILABLE);
}

export default function usePurchaseGate(subject) {
  const { caps } = useCapabilities();
  return useMemo(() => resolvePurchaseGate(subject, caps), [subject, caps]);
}

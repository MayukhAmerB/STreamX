// OWNER: WS-F (plan §5.4, Appendix A.5).
//
//   <FeatureGate feature="teaching">…</FeatureGate>   or as a layout route (renders <Outlet/>)
//
// Staff always pass (their tools are never switched off). For everyone else:
// enabled → children; the viewer's workspace is "disabled" → an in-shell
// "switched off" page with the reason; "hidden" → not found. Never a redirect.
// While capabilities load the gate shows "Checking…" (never flashes the page).
//
// Live changes: if an admin switches the feature off while the page is open
// (focus / 5 min poll / a 403 feature_disabled), the page crossfades to the
// off state and says unsaved work stays on this device; switched on, the page
// enters once (M20).
import { ArrowLeft, Education, Locked } from "@carbon/icons-react";
import { useId, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { NotFoundState } from "../app-shell/ui";
import { useAuth } from "../../hooks/useAuth";
import { FEATURE_WORKSPACES } from "./constants";
import useCapabilities from "./useCapabilities";
import "./featureGate.scss";

const COPY = {
  teaching: {
    title: "Teaching is switched off",
    icon: Education,
    stillWorks: "Your Learn workspace works as usual.",
    switchedOff: "Teaching was switched off by an admin. Unsaved changes are kept on this device.",
  },
};
const FALLBACK_COPY = {
  title: "This section is switched off",
  icon: Locked,
  stillWorks: "",
  switchedOff: "This section was switched off by an admin. Unsaved changes are kept on this device.",
};

export function FeatureOffState({ feature = "teaching", reason, switchedOff = false }) {
  const copy = COPY[feature] || FALLBACK_COPY;
  const Icon = copy.icon;
  const titleId = useId();
  return (
    <section
      className={`sc-state sc-feature-off${switchedOff ? " sc-feature-off--live" : ""}`}
      aria-labelledby={titleId}
      data-feature-off={feature}
    >
      {switchedOff ? (
        <p className="sc-feature-off__notice" role="status">
          <Locked size={16} aria-hidden="true" />
          <span>{copy.switchedOff}</span>
        </p>
      ) : null}
      <Icon size={32} aria-hidden="true" className="sc-state__icon" />
      <h1 id={titleId} className="sc-state__title">
        {copy.title}
      </h1>
      <p className="sc-state__body">{reason || "An admin can turn it on."}</p>
      {copy.stillWorks ? <p className="sc-feature-off__helper">{copy.stillWorks}</p> : null}
      <Link className="sc-state__action" to="/console">
        <ArrowLeft size={16} aria-hidden="true" />
        <span>Back to Home</span>
      </Link>
    </section>
  );
}

function Checking() {
  return (
    <p className="sc-feature-checking" role="status" aria-live="polite">
      Checking…
    </p>
  );
}

/** "enabled" | "disabled" | "hidden" | "checking" (+ reason) for a non-staff viewer. */
export function resolveFeatureGate(feature, caps, loading) {
  if (!caps) {
    return { state: loading ? "checking" : "disabled", reason: "" };
  }
  const workspace = FEATURE_WORKSPACES[feature];
  const entry = workspace ? caps.workspaces?.[workspace] : null;
  if (entry?.state === "hidden") {
    return { state: "hidden", reason: "" };
  }
  const enabled = entry ? entry.state === "enabled" : Boolean(caps.features?.[feature]?.enabled);
  return enabled ? { state: "enabled", reason: "" } : { state: "disabled", reason: entry?.reason || "" };
}

export default function FeatureGate({ feature = "teaching", children }) {
  const { isAdmin } = useAuth() || {};
  const { caps, loading } = useCapabilities();
  const content = children ?? <Outlet />;
  const { state, reason } = resolveFeatureGate(feature, caps, loading);
  // Derived during render (not in an effect) so the page never mounts twice.
  const [seen, setSeen] = useState({ state, transition: null }); // transition: "off" | "on" | null
  let transition = seen.transition;
  if (seen.state !== state) {
    if (seen.state === "enabled" && state === "disabled") transition = "off";
    else if (seen.state === "disabled" && state === "enabled") transition = "on";
    setSeen({ state, transition });
  }

  if (isAdmin) return content;
  if (state === "checking") return <Checking />;
  if (state === "hidden") return <NotFoundState />;
  if (state === "enabled") {
    return transition === "on" ? <div className="sc-feature-reveal">{content}</div> : content;
  }
  return <FeatureOffState feature={feature} reason={reason} switchedOff={transition === "off"} />;
}

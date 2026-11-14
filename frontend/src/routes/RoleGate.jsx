// What a signed-in viewer sees on a route their role does not open (plan
// §2.7). OWNER: WS-B. Rendered lazily by components/ProtectedRoute.jsx so
// the Console states stay out of the website bundle.
//   gate="not-found"  they can never act here → the URL's workspace page
//                     when they have one (staff opening an instructor link),
//                     otherwise an in-shell "not found"
//   gate="teaching"   non-staff instructor → <FeatureGate feature="teaching">
//                     (the page while on; "Teaching is switched off" while off)
import { Outlet } from "react-router-dom";
import WorkspaceRedirect from "../features/app-shell/WorkspaceRedirect";
import { FeatureGate } from "../features/capabilities";

export default function RoleGate({ gate }) {
  if (gate === "teaching") {
    return (
      <FeatureGate feature="teaching">
        <Outlet />
      </FeatureGate>
    );
  }
  return <WorkspaceRedirect />;
}

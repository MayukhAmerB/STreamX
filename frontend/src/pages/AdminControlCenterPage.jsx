// Control center is removed (UI overhaul plan D7): /control-center sends
// staff to Admin home and instructors to Teach Today. OWNER: WS-D2.
// TODO(WS-B): drop the /control-center route's import of this module (point
// the route at <WorkspaceRedirect/> directly); the integrator then deletes
// this file.
import WorkspaceRedirect from "../features/app-shell/WorkspaceRedirect";

export default function AdminControlCenterPage() {
  return <WorkspaceRedirect />;
}

// Old URL /instructor/dashboard → Teach Today (/console/teach, UI overhaul
// plan §3.3); the legacy Tailwind dashboard is gone. OWNER: WS-D2.
import WorkspaceRedirect from "../features/app-shell/WorkspaceRedirect";

export default function InstructorDashboardPage() {
  return <WorkspaceRedirect />;
}

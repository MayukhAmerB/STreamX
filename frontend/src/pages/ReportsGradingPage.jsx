// Old URL /report-grading → Grading › Tasks (/console/{ws}/grading/tasks,
// UI overhaul plan §3.3). OWNER: WS-D2. Forwards old links (query kept).
import WorkspaceRedirect from "../features/app-shell/WorkspaceRedirect";

export { describeCounts, TaskStatusTag } from "../features/grading/GradingTasks";

export default function ReportsGradingPage() {
  return <WorkspaceRedirect />;
}

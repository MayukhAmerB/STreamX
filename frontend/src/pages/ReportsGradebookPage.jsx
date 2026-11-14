// Old URL /report-grading/gradebook → Grading › Marks
// (/console/{ws}/grading/marks, UI overhaul plan §3.3). OWNER: WS-D2.
import WorkspaceRedirect from "../features/app-shell/WorkspaceRedirect";

export { classSummary, GradebookTable } from "../features/grading/GradingMarks";

export default function ReportsGradebookPage() {
  return <WorkspaceRedirect />;
}

// Grading › Settings (UI overhaul plan §3.5): the course report policy that
// used to sit above the task list. OWNER: WS-D2.
import "./Grading.scss";

import { FeatureBoundary, useToast } from "../app-shell/ui";
import ReportPolicyPanel from "../reports/ReportPolicyPanel";

export default function GradingSettings({ course }) {
  const { showToast } = useToast();
  if (!course) return null;
  return (
    <div className="grd-settings">
      <FeatureBoundary key={course.id} label="Report settings">
        <ReportPolicyPanel courseId={course.id} notify={showToast} />
      </FeatureBoundary>
    </div>
  );
}

// Old URL /instructor/courses/new → Courses › New course
// (/console/{ws}/courses/new, UI overhaul plan §3.3). OWNER: WS-D2.
import WorkspaceRedirect from "../features/app-shell/WorkspaceRedirect";

export { buildCoursePayload } from "../features/teach-courses/courseModel";

export default function CreateCoursePage() {
  return <WorkspaceRedirect />;
}

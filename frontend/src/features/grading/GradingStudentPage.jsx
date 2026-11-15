// Grading › Marks › one student (UI overhaul plan §3.3): every weekly report
// and exam for one student, per batch. OWNER: WS-D2. Reuses the unified
// gradebook sections (pages/GradebookPage, WS-C) under the Grading tree.
import "./Grading.scss";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ErrorState, NotFoundState, PageHeader, PageSkeleton } from "../app-shell/ui";
import { getStudentGradebook } from "../gradebook/gradebookApi";
import { StudentIdentityHeader } from "../identity/StudentIdentityHeader";
import { studentLabel } from "../identity/identityModel";
import { StudentSections } from "../../pages/GradebookPage";
import { apiData, apiMessage } from "../../utils/api";
import { gradingPaths, useWorkspaceRoot } from "./workspaceRoot";

export default function GradingStudentPage() {
  const { studentId } = useParams();
  const paths = gradingPaths(useWorkspaceRoot());
  const [state, setState] = useState({ data: null, loading: true, error: "", missing: false });

  const load = useCallback(() => {
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: "", missing: false }));
    getStudentGradebook(studentId)
      .then((response) => alive && setState({ data: apiData(response, null), loading: false, error: "", missing: false }))
      .catch((error) => {
        if (!alive) return;
        const missing = error?.response?.status === 404;
        setState({ data: null, loading: false, error: apiMessage(error, "Please try again."), missing });
      });
    return () => {
      alive = false;
    };
  }, [studentId]);

  useEffect(() => load(), [load]);

  if (state.missing) {
    return <NotFoundState title="This student was not found" backHref={paths.marks()} backLabel="Back to Marks" />;
  }
  const student = state.data?.student;
  return (
    <div className="grd-page">
      <PageHeader
        eyebrow={null}
        breadcrumbs={[
          { label: "Grading", href: paths.queue() },
          { label: "Marks", href: paths.marks() },
        ]}
        title={student || state.data?.identity ? studentLabel(state.data?.identity, student) : "Student"}
        description="Every weekly report and exam for this student, per batch."
      />
      {!state.loading && state.data?.identity ? <StudentIdentityHeader identity={state.data.identity} eyebrow="Student" handlesOnly /> : null}
      {state.loading ? <PageSkeleton label="Loading marks" count={2} /> : null}
      {!state.loading && state.error ? <ErrorState error={`Couldn't load this student. ${state.error}`} onRetry={load} /> : null}
      {!state.loading && state.data ? <StudentSections data={state.data} /> : null}
    </div>
  );
}

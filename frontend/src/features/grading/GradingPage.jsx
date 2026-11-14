// Grading (UI overhaul plan §3.5): tabs Queue · Tasks · Marks · Settings,
// Queue first with its count. OWNER: WS-D2. Mounted on both workspace trees:
// /console/teach/grading[/:tab] and /console/admin/grading[/:tab]; the server
// scopes the data (instructors see their courses, staff see all).
import "./Grading.scss";

import { DocumentExport, Education } from "@carbon/icons-react";
import { Button, Select, SelectItem } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, NotFoundState, PageHeader, PageSkeleton, ScrollTabs } from "../app-shell/ui";
import { listGradableCourses, listSubmissions, marksExportHref } from "../reports/reportsApi";
import { apiData, apiMessage } from "../../utils/api";
import GradingMarks from "./GradingMarks";
import GradingQueue from "./GradingQueue";
import GradingSettings from "./GradingSettings";
import GradingTasks from "./GradingTasks";
import { gradingPaths, useWorkspaceRoot } from "./workspaceRoot";

export const GRADING_TABS = Object.freeze([
  { key: "queue", label: "Queue" },
  { key: "tasks", label: "Tasks" },
  { key: "marks", label: "Marks" },
  { key: "settings", label: "Settings" },
]);

const DESCRIPTIONS = {
  queue: "Mark weekly reports, oldest first.",
  tasks: "Set the weekly tasks students report on.",
  marks: "Every student's marks per weekly task.",
  settings: "How weekly reports work in this course.",
};

/** Gradable courses + the `?course=` selection shared by every tab. */
export function useGradableCourses() {
  const [state, setState] = useState({ items: [], loading: true, error: "" });
  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    listGradableCourses()
      .then((response) => setState({ items: apiData(response, {})?.results || [], loading: false, error: "" }))
      .catch((error) => setState({ items: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

/** The Queue tab badge: how many submissions wait for marks (all courses or one). */
function useAwaitingCount(courseId) {
  const [count, setCount] = useState(null);
  useEffect(() => {
    let alive = true;
    listSubmissions({ status: "awaiting", ...(courseId ? { course: courseId } : {}) })
      .then((response) => alive && setCount(apiData(response, {})?.counts?.awaiting ?? 0))
      .catch(() => alive && setCount(null));
    return () => {
      alive = false;
    };
  }, [courseId]);
  return [count, setCount];
}

export function gradingTabs(paths, { course, count } = {}) {
  const keep = course ? { course } : {};
  return GRADING_TABS.map((tab) => ({
    key: tab.key,
    label: tab.label,
    href: paths.tab(tab.key, keep),
    badge: tab.key === "queue" && count ? count : undefined,
  }));
}

function CoursePicker({ courses, value, allowAll, onChange }) {
  if (!courses.length || (courses.length === 1 && !allowAll)) return null;
  return (
    <div className="grd-course">
      <Select id="grd-course" labelText="Course" size="md" value={value} onChange={(event) => onChange(event.target.value)}>
        {allowAll ? <SelectItem value="" text="All courses" /> : null}
        {courses.map((course) => (
          <SelectItem key={course.id} value={String(course.id)} text={course.title} />
        ))}
      </Select>
    </div>
  );
}

export default function GradingPage() {
  const { tab = "queue" } = useParams();
  const [params, setParams] = useSearchParams();
  const root = useWorkspaceRoot();
  const paths = useMemo(() => gradingPaths(root), [root]);
  const courses = useGradableCourses();
  const courseParam = params.get("course") || "";
  const [count, setCount] = useAwaitingCount(courseParam);
  const known = GRADING_TABS.some((item) => item.key === tab);

  // Tasks, Marks and Settings belong to one course: the chosen one or the first.
  const activeCourse = useMemo(() => {
    const chosen = courses.items.find((course) => String(course.id) === courseParam);
    if (chosen || tab === "queue") return chosen || null;
    return courses.items[0] || null;
  }, [courses.items, courseParam, tab]);

  const chooseCourse = (value) => {
    const next = new URLSearchParams();
    if (value) next.set("course", value);
    setParams(next);
  };

  if (!known) {
    return <NotFoundState title="This grading page does not exist" backHref={paths.queue()} backLabel="Back to Grading" />;
  }

  const header = (
    <PageHeader
      title="Grading"
      eyebrow={null}
      description={DESCRIPTIONS[tab]}
      primaryAction={tab === "tasks" ? { label: "New task", href: paths.newTask(activeCourse ? { course: activeCourse.id } : {}), accent: true } : undefined}
      actions={
        tab === "marks" && activeCourse ? (
          <Button kind="tertiary" renderIcon={DocumentExport} href={marksExportHref({ course: activeCourse.id })}>
            Export CSV
          </Button>
        ) : null
      }
    />
  );

  const tabs = <ScrollTabs label="Grading" activeKey={tab} tabs={gradingTabs(paths, { course: courseParam, count })} />;

  let body;
  if (courses.loading) body = <PageSkeleton label="Loading your courses" count={2} />;
  else if (courses.error) body = <ErrorState error={`Couldn't load your courses. ${courses.error}`} onRetry={courses.reload} />;
  else if (!courses.items.length) {
    body = (
      <EmptyState
        icon={Education}
        title="Nothing to grade yet."
        body="Grading opens once you teach a course with enrolled students."
        action={
          <Link className="grd-link" to={`${root}/courses`}>
            Open courses
          </Link>
        }
      />
    );
  } else {
    body = (
      <>
        {tab === "queue" && params.get("submission") ? null : (
          <CoursePicker courses={courses.items} value={activeCourse ? String(activeCourse.id) : ""} allowAll={tab === "queue"} onChange={chooseCourse} />
        )}
        {tab === "queue" ? <GradingQueue onCount={setCount} /> : null}
        {tab === "tasks" ? <GradingTasks course={activeCourse} paths={paths} /> : null}
        {tab === "marks" ? <GradingMarks course={activeCourse} paths={paths} /> : null}
        {tab === "settings" ? <GradingSettings course={activeCourse} /> : null}
      </>
    );
  }

  return (
    <div className="grd-page" data-tab={tab}>
      {header}
      {tabs}
      <div className="grd-page__body">{body}</div>
    </div>
  );
}

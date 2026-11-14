// Teach › Courses and Admin › Courses (UI overhaul plan §3.5, §4.3; T2 list).
// OWNER: WS-D2. Replaces the legacy Tailwind instructor dashboard.
// Instructors list and author their own courses. Staff see every published
// course here; drafts and staff-only fields stay in the back office until the
// wave-2 Pricing / Page copy tabs ship.
import "./TeachCourses.scss";

import { Add, Education, Launch } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, PageHeader, PageSkeleton, ResponsiveTable, StatusTag, T2List, Toolbar } from "../app-shell/ui";
import { useAuth } from "../../hooks/useAuth";
import { apiData, apiMessage } from "../../utils/api";
import { formatINR } from "../../utils/currency";
import { useWorkspaceRoot } from "../grading/workspaceRoot";
import { describeCurriculum } from "./courseModel";
import { getInstructorCourses, listCourses } from "./teachCoursesApi";

export const COURSE_FILTERS = Object.freeze([
  { key: "all", label: "All" },
  { key: "published", label: "Published" },
  { key: "draft", label: "Drafts" },
]);

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.results || [];
}

/** Courses matching the chip and the search box (title or description). */
export function filterCourses(courses, { filter = "all", query = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return (courses || []).filter((course) => {
    if (filter === "published" && !course.is_published) return false;
    if (filter === "draft" && course.is_published) return false;
    if (!needle) return true;
    return `${course.title || ""} ${course.description || ""}`.toLowerCase().includes(needle);
  });
}

function formatUpdated(value) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function courseColumns() {
  return [
    {
      key: "title",
      header: "Course",
      render: (course) => (
        <span className="tch-course-cell">
          <span className="tch-course-cell__title">{course.title}</span>
        </span>
      ),
    },
    { key: "status", header: "Status", render: (course) => <StatusTag status={course.is_published ? "published" : "draft"} /> },
    {
      key: "curriculum",
      header: "Curriculum",
      render: (course) => describeCurriculum({ modules: course.section_count, lectures: course.lecture_count }),
    },
    { key: "price", header: "Price", render: (course) => (Number(course.price) ? formatINR(course.price) : "Free") },
    { key: "updated", header: "Updated", render: (course) => formatUpdated(course.updated_at) },
  ];
}

export default function TeachCoursesPage() {
  const root = useWorkspaceRoot();
  const auth = useAuth() || {};
  const isInstructor = Boolean(auth.isInstructor);
  const staffOnly = Boolean(auth.isAdmin) && !isInstructor;
  const [state, setState] = useState({ items: [], loading: true, error: "" });
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    const requests = [isInstructor ? getInstructorCourses() : Promise.resolve(null), auth.isAdmin ? listCourses({}) : Promise.resolve(null)];
    Promise.all(requests)
      .then(([mine, catalog]) => {
        const byId = new Map();
        [...asList(apiData(mine, [])), ...asList(apiData(catalog, []))].forEach((course) => {
          if (course?.id != null && !byId.has(course.id)) byId.set(course.id, course);
        });
        const items = [...byId.values()].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
        setState({ items, loading: false, error: "" });
      })
      .catch((error) => setState({ items: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, [isInstructor, auth.isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => filterCourses(state.items, { filter, query }), [state.items, filter, query]);
  const counts = useMemo(
    () => ({
      all: state.items.length,
      published: state.items.filter((course) => course.is_published).length,
      draft: state.items.filter((course) => !course.is_published).length,
    }),
    [state.items]
  );

  const newCourseHref = `${root}/courses/new`;
  const header = (
    <PageHeader
      eyebrow={null}
      title="Courses"
      description={staffOnly ? "Every published course. Drafts and pricing live in the back office for now." : "Create courses, build the curriculum and publish."}
      primaryAction={isInstructor ? { label: "New course", href: newCourseHref, accent: true } : undefined}
      actions={
        staffOnly ? (
          <Button kind="tertiary" renderIcon={Launch} href="/admin/courses/course/">
            Back office
          </Button>
        ) : null
      }
    />
  );

  let main;
  if (state.loading) main = <PageSkeleton label="Loading courses" count={3} />;
  else if (state.error) main = <ErrorState error={`Couldn't load courses. ${state.error}`} onRetry={load} />;
  else if (!state.items.length) {
    main = (
      <EmptyState
        icon={Education}
        title={isInstructor ? "You have no courses yet." : "No published courses yet."}
        body={isInstructor ? "Start with a title and a short description; you add modules and lectures next." : "Courses are created by instructors, or in the back office."}
        action={
          isInstructor ? (
            <Button as={Link} to={newCourseHref} kind="tertiary" renderIcon={Add}>
              New course
            </Button>
          ) : (
            <Button kind="tertiary" renderIcon={Launch} href="/admin/courses/course/add/">
              Add a course in the back office
            </Button>
          )
        }
      />
    );
  } else {
    main = (
      <ResponsiveTable
        columns={courseColumns()}
        rows={visible}
        getRowHref={(course) => `${root}/courses/${course.id}`}
        emptyState={<p className="tch-muted tch-none">No courses match. Clear the search or choose All.</p>}
      />
    );
  }

  return (
    <div className="tch-page">
      <T2List
        header={header}
        toolbar={
          state.items.length ? (
            <Toolbar
              search={{ value: query, onChange: setQuery, placeholder: "Search courses" }}
              chips={COURSE_FILTERS.map((item) => ({ key: item.key, label: item.label, active: filter === item.key, count: counts[item.key], onClick: () => setFilter(item.key) }))}
            />
          ) : null
        }
        main={main}
      />
    </div>
  );
}

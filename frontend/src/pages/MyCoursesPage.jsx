import "./MyCoursesPage.scss";

import { Catalog, Education, ToolKit } from "@carbon/icons-react";
import { Button, Search } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMyCourses } from "../api/courses";
import useCapabilities from "../features/capabilities/useCapabilities";
import { MembershipIncludedSection, useMembershipLibrary } from "../features/my-courses/MembershipIncluded";
import CourseProgressTile from "../features/my-courses/CourseProgressTile";
import { EmptyState, PageHeader, PageNotification, PageSkeleton } from "../features/app-shell/ui";
import { apiData, apiMessage } from "../utils/api";
import { isOsintCourse } from "../utils/courseAccess";

/** Show the search box only when the list is long enough to need it. */
export const SEARCH_THRESHOLD = 4;

export function getStudentLibraryStats(courses = []) {
  const normalizedCourses = Array.isArray(courses) ? courses : [];
  const inProgress = normalizedCourses.filter((course) => {
    const percent = Number(course?.progress_percent || 0);
    return percent > 0 && percent < 100;
  }).length;
  const completed = normalizedCourses.filter(
    (course) => Number(course?.progress_percent || 0) >= 100,
  ).length;

  return { total: normalizedCourses.length, inProgress, completed };
}

/**
 * The one course whose button is the screen's champagne action (plan §3.4):
 * the first in progress, else the first not finished, else none.
 */
export function pickAccentCourseId(courses = []) {
  const list = Array.isArray(courses) ? courses : [];
  const percent = (course) => Number(course?.progress_percent || 0);
  const inProgress = list.find((course) => percent(course) > 0 && percent(course) < 100);
  const notStarted = list.find((course) => percent(course) < 100);
  return (inProgress || notStarted)?.id ?? null;
}

export function filterCourses(courses = [], query = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return courses;
  return courses.filter((course) => String(course?.title || "").toLowerCase().includes(needle));
}

const BrowseButton = ({ kind = "primary" }) => (
  <Button as={Link} to="/courses" kind={kind} renderIcon={Catalog}>
    Browse courses
  </Button>
);

/** Presentational view, also used by tests and the visual harness. */
export function MyCoursesView({ courses = [], loading = false, error = "", onRetry, membership = null }) {
  const [query, setQuery] = useState("");
  const accentId = useMemo(() => pickAccentCourseId(courses), [courses]);
  const hasOsintAccess = useMemo(() => courses.some(isOsintCourse), [courses]);
  const visibleCourses = useMemo(() => filterCourses(courses, query), [courses, query]);

  return (
    <>
      <PageHeader
        title="My courses"
        description="Pick a course to continue where you left off."
        actions={<BrowseButton kind="tertiary" />}
      />

      {loading ? <PageSkeleton label="Loading your courses" /> : null}

      {!loading && error ? (
        <PageNotification
          kind="error"
          title="Couldn't load your courses."
          subtitle={error}
          actionLabel={onRetry ? "Try again" : undefined}
          onAction={onRetry}
        />
      ) : null}

      {!loading && !error && courses.length === 0 ? (
        <EmptyState
          icon={Education}
          text="Your purchased or approved courses will appear here."
          action={<BrowseButton />}
        />
      ) : null}

      {!loading && !error && courses.length > 0 ? (
        <>
          {hasOsintAccess ? (
            <div className="cds-library-callout">
              <span className="cds-library-callout__icon" aria-hidden="true">
                <ToolKit size={20} />
              </span>
              <p className="cds-library-callout__text">
                <strong>OSINT tools included.</strong> Your investigation toolkit comes with your OSINT course.
              </p>
              <Button as={Link} to="/osint-tools" kind="tertiary" size="md" renderIcon={ToolKit}>
                Open tools
              </Button>
            </div>
          ) : null}

          {courses.length >= SEARCH_THRESHOLD ? (
            <div className="cds-library-search">
              <Search
                size="lg"
                labelText="Search your courses"
                placeholder="Search your courses"
                closeButtonLabelText="Clear search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          ) : null}

          {visibleCourses.length > 0 ? (
            <section className="cds-tile-grid" aria-label="Courses">
              {visibleCourses.map((course) => (
                <CourseProgressTile key={course.id} course={course} accent={course.id === accentId} />
              ))}
            </section>
          ) : (
            <EmptyState
              icon={Education}
              text="No course matches your search."
              action={
                <Button kind="tertiary" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              }
            />
          )}
        </>
      ) : null}

      {!loading ? <MembershipIncludedSection library={membership} /> : null}
    </>
  );
}

export default function MyCoursesPage() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const response = await getMyCourses();
        const myCourses = apiData(response, []);
        if (active) setCourses(Array.isArray(myCourses) ? myCourses : []);
      } catch (err) {
        if (active) setError(apiMessage(err, "Please check your connection and try again."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  // OSINT plans (switch `memberships`, off by default): recordings included
  // without an enrollment. No request at all while the switch is off.
  const { caps } = useCapabilities();
  const ownedIds = useMemo(() => courses.map((course) => course?.id), [courses]);
  const membership = useMembershipLibrary(Boolean(caps?.features?.memberships?.enabled), ownedIds);

  return <MyCoursesView courses={courses} loading={loading} error={error} onRetry={retry} membership={membership} />;
}

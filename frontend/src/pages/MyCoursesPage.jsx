import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMyCourses } from "../api/courses";
import Button from "../components/Button";
import OsintToolsAccessCard from "../components/OsintToolsAccessCard";
import OwnedCourseCard from "../components/OwnedCourseCard";
import PageShell from "../components/PageShell";
import { apiData, apiMessage } from "../utils/api";
import { isOsintCourse } from "../utils/courseAccess";

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

export default function MyCoursesPage() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await getMyCourses();
        const myCourses = apiData(response, []);
        if (active) {
          setCourses(Array.isArray(myCourses) ? myCourses : []);
        }
      } catch (err) {
        if (active) setError(apiMessage(err, "Failed to load your courses."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const libraryStats = useMemo(() => getStudentLibraryStats(courses), [courses]);
  const hasOsintAccess = useMemo(() => courses.some(isOsintCourse), [courses]);

  return (
    <PageShell
      title="Your Courses"
      subtitle="Your private learning library. Open any course here once it has been purchased or approved for your account."
      badge="Student Library"
      action={
        <Link to="/courses" className="inline-flex">
          <Button variant="secondary">Browse Catalog</Button>
        </Link>
      }
    >
      {loading ? (
        <p className="text-sm text-[#BBBBBB]">Loading your course library...</p>
      ) : null}

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {!loading && !error ? (
        <>
          <section className="student-library-stats mb-5 grid grid-cols-3 gap-2 sm:mb-6 sm:gap-4">
            <div className="student-library-stat rounded-[16px] border border-black panel-gradient p-3 shadow-[0_12px_35px_rgba(0,0,0,0.2)] sm:rounded-[24px] sm:p-5 sm:shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
              <div className="student-library-muted text-[10px] uppercase tracking-[0.16em] text-[#949494]">Courses Ready</div>
              <div className="student-library-stat-value mt-2 text-2xl font-semibold text-white sm:text-3xl">{libraryStats.total}</div>
              <p className="student-library-muted mt-2 hidden text-sm text-[#BBBBBB] sm:block">Courses currently unlocked for this account.</p>
            </div>
            <div className="student-library-stat rounded-[16px] border border-black panel-gradient p-3 shadow-[0_12px_35px_rgba(0,0,0,0.2)] sm:rounded-[24px] sm:p-5 sm:shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
              <div className="student-library-muted text-[10px] uppercase tracking-[0.16em] text-[#949494]">In Progress</div>
              <div className="student-library-stat-value mt-2 text-2xl font-semibold text-white sm:text-3xl">{libraryStats.inProgress}</div>
              <p className="student-library-muted mt-2 hidden text-sm text-[#BBBBBB] sm:block">Courses where learning has already started.</p>
            </div>
            <div className="student-library-stat rounded-[16px] border border-black panel-gradient p-3 shadow-[0_12px_35px_rgba(0,0,0,0.2)] sm:rounded-[24px] sm:p-5 sm:shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
              <div className="student-library-muted text-[10px] uppercase tracking-[0.16em] text-[#949494]">Completed</div>
              <div className="student-library-stat-value mt-2 text-2xl font-semibold text-white sm:text-3xl">{libraryStats.completed}</div>
              <p className="student-library-muted mt-2 hidden text-sm text-[#BBBBBB] sm:block">Courses with every published lesson completed.</p>
            </div>
          </section>

          {hasOsintAccess ? <OsintToolsAccessCard className="mb-6" /> : null}

          {courses.length === 0 ? (
            <div className="rounded-[28px] border border-black panel-gradient p-6 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
              <h2 className="font-reference text-xl font-semibold text-white">No courses unlocked yet</h2>
              <p className="mt-2 max-w-2xl text-sm leading-7 text-[#BBBBBB]">
                Once you purchase a course or an admin approves your enrollment request, it will appear here automatically.
              </p>
              <Link to="/courses" className="mt-4 inline-flex">
                <Button>Browse Courses</Button>
              </Link>
            </div>
          ) : (
            <section className="grid gap-4 sm:gap-5">
              {courses.map((course) => (
                <OwnedCourseCard key={course.id} course={course} />
              ))}
            </section>
          )}
        </>
      ) : null}
    </PageShell>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMyCourses } from "../api/courses";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { formatINR } from "../utils/currency";
import { apiData, apiMessage } from "../utils/api";

const fallbackCourseImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

function formatLevel(level) {
  if (!level) return "Program";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function formatAccessDate(value) {
  if (!value) return "Recently added";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Recently added";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function getAccessBadgeClasses(source) {
  if (String(source || "").toLowerCase() === "purchased") {
    return "border border-[#DEDEDE] bg-[#F0F0F0] text-[#272727]";
  }
  return "border border-[#CCCCCC]/20 bg-white/5 text-[#DBDBDB]";
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
          setCourses(myCourses);
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

  const libraryStats = useMemo(() => {
    const purchasedCount = courses.filter(
      (course) => String(course.access_source || "").toLowerCase() === "purchased"
    ).length;
    return {
      total: courses.length,
      purchased: purchasedCount,
      granted: Math.max(courses.length - purchasedCount, 0),
    };
  }, [courses]);

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
          <section className="mb-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-[24px] border border-black panel-gradient p-5 shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Courses Ready</div>
              <div className="mt-2 text-3xl font-semibold text-white">{libraryStats.total}</div>
              <p className="mt-2 text-sm text-[#BBBBBB]">Courses currently unlocked for this account.</p>
            </div>
            <div className="rounded-[24px] border border-black panel-gradient p-5 shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Purchased</div>
              <div className="mt-2 text-3xl font-semibold text-white">{libraryStats.purchased}</div>
              <p className="mt-2 text-sm text-[#BBBBBB]">Courses unlocked through payment verification.</p>
            </div>
            <div className="rounded-[24px] border border-black panel-gradient p-5 shadow-[0_18px_50px_rgba(0,0,0,0.22)]">
              <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Granted</div>
              <div className="mt-2 text-3xl font-semibold text-white">{libraryStats.granted}</div>
              <p className="mt-2 text-sm text-[#BBBBBB]">Courses approved for access by your admin team.</p>
            </div>
          </section>

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
            <section className="grid gap-5 lg:grid-cols-2">
              {courses.map((course) => (
                <article
                  key={course.id}
                  className="relative overflow-hidden rounded-[28px] border border-black panel-gradient shadow-[0_20px_60px_rgba(0,0,0,0.24)]"
                >
                  <div className="absolute inset-0">
                    <img
                      src={course.thumbnail || fallbackCourseImage}
                      alt=""
                      aria-hidden="true"
                      className="h-full w-full object-cover opacity-[0.16]"
                    />
                    <div className="absolute inset-0 bg-gradient-to-br from-black/88 via-[#0D0D0D]/88 to-[#141414]/95" />
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_10%,rgba(192,192,192,0.12),transparent_38%)]" />
                  </div>

                  <div className="relative flex h-full flex-col p-5 sm:p-6">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${getAccessBadgeClasses(
                          course.access_source
                        )}`}
                      >
                        {course.access_label || "Unlocked"}
                      </span>
                      <span className="rounded-full border border-black bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#DBDBDB]">
                        {formatLevel(course.level)}
                      </span>
                      <span className="rounded-full border border-black bg-[#141414] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#BBBBBB]">
                        {course.section_count || 0} modules
                      </span>
                    </div>

                    <h2 className="mt-4 font-reference text-2xl font-semibold text-white">{course.title}</h2>
                    <p className="mt-2 line-clamp-3 text-sm leading-7 text-[#BBBBBB]">
                      {course.description || "Your course description will appear here once the curriculum is published."}
                    </p>

                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl border border-black panel-gradient p-3">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Lessons</div>
                        <div className="mt-1 text-lg font-semibold text-white">{course.lecture_count || 0}</div>
                      </div>
                      <div className="rounded-2xl border border-black panel-gradient p-3">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Instructor</div>
                        <div className="mt-1 truncate text-sm font-semibold text-white">
                          {course.instructor?.full_name || "Instructor"}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-black panel-gradient p-3">
                        <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Price</div>
                        <div className="mt-1 text-sm font-semibold text-white">{formatINR(course.price)}</div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-2xl border border-black panel-gradient p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#AFAFAF]">
                        <span>
                          Access added on <span className="font-semibold text-[#E2E2E2]">{formatAccessDate(course.enrolled_at)}</span>
                        </span>
                        <span>{course.category === "web_pentesting" ? "Web Pentesting" : "OSINT"}</span>
                      </div>
                    </div>

                    <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                      <Link to={`/learn/${course.id}`} className="sm:flex-1">
                        <Button className="w-full">Continue Learning</Button>
                      </Link>
                      <Link to={`/courses/${course.id}`} className="sm:flex-1">
                        <Button variant="secondary" className="w-full">
                          View Details
                        </Button>
                      </Link>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      ) : null}
    </PageShell>
  );
}

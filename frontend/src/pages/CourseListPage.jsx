import { useEffect, useMemo, useState } from "react";

import { listCourses } from "../api/courses";
import CourseCard from "../components/CourseCard";
import PageShell from "../components/PageShell";
import { apiData } from "../utils/api";
import {
  filterCourseCatalog,
  readCachedCourseCatalog,
  writeCachedCourseCatalog,
} from "../utils/courseCatalog";
import { getCourseLaunchStatus } from "../utils/courseStatus";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/8d/ad/8a/8dad8ae3fa8915b93754dfffdd421b62.jpg";

export function getCourseCatalogSummary(courses) {
  return {
    live: courses.filter((course) => getCourseLaunchStatus(course).isLive).length,
    comingSoon: courses.filter((course) => getCourseLaunchStatus(course).isComingSoon).length,
    osint: courses.filter((course) => course.category === "osint").length,
    web: courses.filter((course) => course.category === "web_pentesting").length,
  };
}

export function getCourseLevelSummary(courses) {
  return courses.reduce(
    (acc, course) => {
      const level = course?.level || "other";
      if (acc[level] !== undefined) acc[level] += 1;
      return acc;
    },
    { beginner: 0, intermediate: 0, advanced: 0, other: 0 }
  );
}

export function CourseCatalogContent({
  courses = [],
  loading = false,
  error = "",
  search = "",
  setSearch = () => {},
  summary = getCourseCatalogSummary(courses),
  levelSummary = getCourseLevelSummary(courses),
}) {
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-reference text-lg font-semibold text-white">Available Tracks</h3>
            <p className="mt-1 text-xs text-[#949494]">
              Explore the catalog and open any course to view modules, lessons, and enrollment
              status.
            </p>
          </div>
          <span className="whitespace-nowrap text-xs text-[#949494]">
            {loading ? "Loading..." : `${courses.length} result${courses.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {loading ? <p className="mb-4 text-sm text-[#BBBBBB]">Loading course catalog...</p> : null}
        {error ? (
          <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
            {error}
          </div>
        ) : null}

        {!loading && courses.length === 0 ? (
          <div className="rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] p-6 text-sm text-[#1D1D1D]">
            {search ? "No courses found." : "No courses are available right now."}
          </div>
        ) : null}

        {courses.length > 0 ? (
          <div className="relative rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
            <div className="absolute inset-0 rounded-[26px] bg-[radial-gradient(circle_at_0%_0%,rgba(192,192,192,0.07),transparent_35%)]" />
            <div className="relative grid auto-rows-fr gap-5 lg:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-3">
              {courses.map((course) => (
                <CourseCard key={course.id} course={course} />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <aside className="space-y-4 xl:sticky xl:top-24">
        <section className="relative overflow-hidden rounded-[28px] border border-black bg-[#080808] shadow-[0_26px_70px_rgba(0,0,0,0.35)]">
          <div className="absolute inset-0">
            <img
              src={pageBackgroundImage}
              alt=""
              aria-hidden="true"
              className="h-full w-full object-cover opacity-[0.12]"
            />
            <div className="absolute inset-0 bg-gradient-to-br from-black/88 via-black/84 to-[#111111]/96" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(192,192,192,0.14),transparent_38%)]" />
          </div>

          <div className="relative space-y-4 p-4 sm:p-5">
            <div>
              <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-[10px] font-semibold tracking-[0.16em] text-[#DBDBDB]">
                CATALOG DETAILS
              </div>
              <h2 className="mt-3 font-reference text-xl font-semibold tracking-tight text-white sm:text-2xl">
                {loading ? "Loading courses..." : `${courses.length} courses across OSINT and Web Pentesting`}
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                Search the catalog, review the current mix of live and upcoming tracks, and jump
                directly into the course you need.
              </p>
            </div>

            <label className="block">
              <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#F0F0F0]">
                Search
              </span>
              <input
                type="text"
                placeholder="Search courses..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-white/65 bg-white/92 px-3.5 py-2.5 text-sm text-[#111111] placeholder:text-[#626262] shadow-[inset_0_1px_0_rgba(255,255,255,0.96)] focus:border-white focus:outline-none focus:ring-2 focus:ring-white/25"
              />
            </label>

            <div className="grid auto-rows-fr grid-cols-2 gap-2">
              <div className="rounded-xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] px-3 py-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#444444]">Live</div>
                <div className="mt-1 text-lg font-extrabold text-[#111111]">{summary.live}</div>
              </div>
              <div className="rounded-xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] px-3 py-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#444444]">
                  Coming Soon
                </div>
                <div className="mt-1 text-lg font-extrabold text-[#111111]">{summary.comingSoon}</div>
              </div>
              <div className="rounded-xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] px-3 py-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#444444]">OSINT</div>
                <div className="mt-1 text-lg font-extrabold text-[#111111]">{summary.osint}</div>
              </div>
              <div className="rounded-xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] px-3 py-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#444444]">Web</div>
                <div className="mt-1 text-lg font-extrabold text-[#111111]">{summary.web}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4 rounded-2xl border border-black bg-[linear-gradient(90deg,#050505_0%,#0E0E0E_52%,#1A1A1A_100%)] p-4 text-white shadow-[0_10px_30px_rgba(0,0,0,0.22)]">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E6E6E6]">
              Search & Filter
            </div>
            <p className="mt-2 text-sm leading-6 text-[#F1F1F1]">
              Course status, category, and level totals update automatically from backend data.
            </p>
          </div>

          <div className="grid auto-rows-fr grid-cols-2 gap-2 text-sm">
            <div className="h-full rounded-xl border border-white/40 bg-black/25 px-3 py-2 backdrop-blur-sm">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[#E1E1E1]">Beginner</div>
              <div className="mt-1 font-semibold text-white">{levelSummary.beginner}</div>
            </div>
            <div className="h-full rounded-xl border border-white/40 bg-black/25 px-3 py-2 backdrop-blur-sm">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[#E1E1E1]">
                Intermediate
              </div>
              <div className="mt-1 font-semibold text-white">{levelSummary.intermediate}</div>
            </div>
            <div className="h-full rounded-xl border border-white/40 bg-black/25 px-3 py-2 backdrop-blur-sm">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[#E1E1E1]">Advanced</div>
              <div className="mt-1 font-semibold text-white">{levelSummary.advanced}</div>
            </div>
            <div className="h-full rounded-xl border border-white/40 bg-black/25 px-3 py-2 backdrop-blur-sm">
              <div className="text-[10px] uppercase tracking-[0.14em] text-[#E1E1E1]">Results</div>
              <div className="mt-1 font-semibold text-white">{loading ? "..." : courses.length}</div>
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

export default function CourseListPage() {
  const [courses, setCourses] = useState(() => readCachedCourseCatalog());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);

      const fetchCourses = async () => {
        let lastError = null;

        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const response = await listCourses(search ? { search } : {});
            const apiCourses = apiData(response, []);
            return Array.isArray(apiCourses) ? apiCourses : [];
          } catch (err) {
            lastError = err;
            if (attempt === 0) {
              await new Promise((resolve) => {
                window.setTimeout(resolve, 350);
              });
            }
          }
        }

        throw lastError;
      };

      try {
        const apiCourses = await fetchCourses();
        if (active) {
          if (!search) {
            writeCachedCourseCatalog(apiCourses);
          }
          setCourses(apiCourses);
          setError("");
        }
      } catch {
        if (active) {
          const cachedCourses = filterCourseCatalog(readCachedCourseCatalog(), search);
          setCourses(cachedCourses);
          setError(
            cachedCourses.length
              ? "Showing last synced course catalog. Live refresh failed."
              : "Course catalog is temporarily unavailable. Please try again."
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search]);

  const summary = useMemo(() => getCourseCatalogSummary(courses), [courses]);
  const levelSummary = useMemo(() => getCourseLevelSummary(courses), [courses]);

  return (
    <PageShell
      title="Course Catalog"
      subtitle="Browse OSINT and web application pentesting tracks."
      decryptTitle
    >
      <CourseCatalogContent
        courses={courses}
        loading={loading}
        error={error}
        search={search}
        setSearch={setSearch}
        summary={summary}
        levelSummary={levelSummary}
      />
    </PageShell>
  );
}

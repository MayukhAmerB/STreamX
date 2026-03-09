import { useEffect, useMemo, useState } from "react";
import CourseCard from "../components/CourseCard";
import PageShell from "../components/PageShell";
import { listCourses } from "../api/courses";
import { apiData } from "../utils/api";
import { featuredCourse } from "../utils/featuredCourse";
import { getCourseLaunchStatus } from "../utils/courseStatus";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

export default function CourseListPage() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await listCourses(search ? { search } : {});
        if (active) {
          const apiCourses = apiData(response, []);
          setCourses(apiCourses.length ? apiCourses : [featuredCourse]);
          setError("");
        }
      } catch {
        if (active) {
          const matches = featuredCourse.title.toLowerCase().includes(search.toLowerCase());
          setCourses(matches || !search ? [featuredCourse] : []);
          setError("Showing local featured course preview. Backend is unavailable.");
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

  const summary = useMemo(() => {
    const live = courses.filter((course) => getCourseLaunchStatus(course).isLive).length;
    const comingSoon = courses.filter((course) => getCourseLaunchStatus(course).isComingSoon).length;
    const osint = courses.filter((course) => course.category === "osint").length;
    const web = courses.filter((course) => course.category === "web_pentesting").length;
    return { live, comingSoon, osint, web };
  }, [courses]);

  const levelSummary = useMemo(() => {
    return courses.reduce(
      (acc, course) => {
        const level = course?.level || "other";
        if (acc[level] !== undefined) acc[level] += 1;
        return acc;
      },
      { beginner: 0, intermediate: 0, advanced: 0, other: 0 }
    );
  }, [courses]);

  return (
    <PageShell title="Course Catalog" subtitle="Browse OSINT and web application pentesting tracks.">
      <section className="relative mb-6 overflow-hidden rounded-[30px] border border-black bg-[#080808] shadow-[0_26px_70px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.15]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/86 via-black/78 to-[#111111]/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(192,192,192,0.14),transparent_38%)]" />
        </div>


        <div className="relative p-5 sm:p-6">
          <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
            <div>
              <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#DBDBDB]">
                COURSE CATALOG
              </div>
              <h2 className="mt-4 max-w-3xl font-reference text-2xl font-semibold tracking-tight text-white sm:text-3xl lg:text-[2.2rem]">
                {loading ? "Loading courses..." : `${courses.length} courses across OSINT and Web Pentesting`}
              </h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-[#BBBBBB]">
                Explore beginner to advanced tracks. Live courses are ready for enrollment, and
                upcoming tracks are marked as coming soon.
              </p>

              <div className="mt-5 grid gap-3 sm:auto-rows-fr sm:grid-cols-2 xl:grid-cols-4">
                <div className="h-full rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] p-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#444444]">Live Tracks</div>
                  <div className="mt-1 text-xl font-semibold text-[#111111]">{summary.live}</div>
                  <div className="mt-1 text-xs text-[#2E2E2E]">Ready for enrollment</div>
                </div>
                <div className="h-full rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] p-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#444444]">
                    Coming Soon
                  </div>
                  <div className="mt-1 text-xl font-semibold text-[#111111]">{summary.comingSoon}</div>
                  <div className="mt-1 text-xs text-[#2E2E2E]">Upcoming releases</div>
                </div>
                <div className="h-full rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] p-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#444444]">OSINT</div>
                  <div className="mt-1 text-xl font-semibold text-[#111111]">{summary.osint}</div>
                  <div className="mt-1 text-xs text-[#2E2E2E]">Investigation tracks</div>
                </div>
                <div className="h-full rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] p-3">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#444444]">Web Pentesting</div>
                  <div className="mt-1 text-xl font-semibold text-[#111111]">{summary.web}</div>
                  <div className="mt-1 text-xs text-[#2E2E2E]">Application security</div>
                </div>
              </div>
            </div>

            <div className="space-y-4 rounded-2xl border border-black bg-[linear-gradient(90deg,#050505_0%,#0E0E0E_52%,#1A1A1A_100%)] p-4 text-white shadow-[0_10px_30px_rgba(0,0,0,0.22)]">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E6E6E6]">
                  Search & Filter
                </div>
                <p className="mt-2 text-sm leading-6 text-[#F1F1F1]">
                  Search by title or description keywords. Course status and category badges update
                  automatically from backend data.
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
                  <div className="mt-1 font-semibold text-white">
                    {loading ? "..." : courses.length}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-reference text-lg font-semibold text-white">Available Tracks</h3>
          <p className="mt-1 text-xs text-[#949494]">
            Explore the catalog and open any course to view modules, lessons, and enrollment status.
          </p>
        </div>
        <span className="whitespace-nowrap text-xs text-[#949494]">
          {loading ? "Loading..." : `${courses.length} result${courses.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {loading && <p className="text-sm text-[#BBBBBB]">Loading course catalog...</p>}
      {error ? (
        <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      ) : null}
      {!loading && !error && courses.length === 0 ? (
        <div className="rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] p-6 text-sm text-[#1D1D1D]">
          No courses found.
        </div>
      ) : null}

      <div className="relative rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
        <div className="absolute inset-0 rounded-[26px] bg-[radial-gradient(circle_at_0%_0%,rgba(192,192,192,0.07),transparent_35%)]" />
        <div className="relative grid auto-rows-fr gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {courses.map((course) => (
            <CourseCard key={course.id} course={course} />
          ))}
        </div>
      </div>
    </PageShell>
  );
}

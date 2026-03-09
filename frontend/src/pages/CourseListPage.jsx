import { useEffect, useMemo, useState } from "react";
import CourseCard from "../components/CourseCard";
import FormInput from "../components/FormInput";
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

        <div className="absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:28px_28px]" />

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
                <div className="h-full rounded-2xl border border-black panel-gradient p-3 backdrop-blur-sm">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Live Tracks</div>
                  <div className="mt-1 text-xl font-semibold text-white">{summary.live}</div>
                  <div className="mt-1 text-xs text-[#BBBBBB]">Ready for enrollment</div>
                </div>
                <div className="h-full rounded-2xl border border-black bg-[#D9D9D9]/16 p-3 backdrop-blur-sm">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#CECECE]">
                    Coming Soon
                  </div>
                  <div className="mt-1 text-xl font-semibold text-white">{summary.comingSoon}</div>
                  <div className="mt-1 text-xs text-[#BBBBBB]">Upcoming releases</div>
                </div>
                <div className="h-full rounded-2xl border border-black panel-gradient p-3 backdrop-blur-sm">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">OSINT</div>
                  <div className="mt-1 text-xl font-semibold text-white">{summary.osint}</div>
                  <div className="mt-1 text-xs text-[#BBBBBB]">Investigation tracks</div>
                </div>
                <div className="h-full rounded-2xl border border-black panel-gradient p-3 backdrop-blur-sm">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Web Pentesting</div>
                  <div className="mt-1 text-xl font-semibold text-white">{summary.web}</div>
                  <div className="mt-1 text-xs text-[#BBBBBB]">Application security</div>
                </div>
              </div>
            </div>

            <div className="space-y-4 rounded-2xl border border-black panel-gradient p-4 backdrop-blur-sm">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                  Search & Filter
                </div>
                <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                  Search by title or description keywords. Course status and category badges update
                  automatically from backend data.
                </p>
              </div>
              <FormInput
                label="Search"
                placeholder="Search courses..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />

              <div className="grid auto-rows-fr grid-cols-2 gap-2 text-sm">
                <div className="h-full rounded-xl border border-black panel-gradient px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Beginner</div>
                  <div className="mt-1 font-semibold text-white">{levelSummary.beginner}</div>
                </div>
                <div className="h-full rounded-xl border border-black panel-gradient px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">
                    Intermediate
                  </div>
                  <div className="mt-1 font-semibold text-white">{levelSummary.intermediate}</div>
                </div>
                <div className="h-full rounded-xl border border-black panel-gradient px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Advanced</div>
                  <div className="mt-1 font-semibold text-white">{levelSummary.advanced}</div>
                </div>
                <div className="h-full rounded-xl border border-black panel-gradient px-3 py-2">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Results</div>
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
        <div className="rounded-2xl border border-black panel-gradient p-6 text-sm text-[#BBBBBB]">
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

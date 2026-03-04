import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getInstructorCourses } from "../api/courses";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import WorkflowGuidePanel from "../components/admin/WorkflowGuidePanel";
import { apiData, apiMessage } from "../utils/api";
import { formatINR } from "../utils/currency";

export default function InstructorDashboardPage() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await getInstructorCourses();
        if (active) setCourses(apiData(response, []));
      } catch (err) {
        if (active) setError(apiMessage(err, "Failed to load instructor courses."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const publishedCount = courses.filter((course) => course.is_published).length;
  const draftCount = courses.length - publishedCount;

  return (
    <PageShell
      title="Instructor Dashboard"
      subtitle="Manage curriculum, publish quality content, and monitor delivery readiness."
      badge="INSTRUCTOR CONTROL"
      action={
        <Link to="/instructor/courses/new">
          <Button>Create Course</Button>
        </Link>
      }
    >
      <div className="mb-5 grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border border-[#29362a] bg-[#0f1610]/92 p-4 shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#92a08f]">Total Courses</div>
          <div className="mt-2 text-3xl font-semibold text-white">{courses.length}</div>
        </div>
        <div className="rounded-2xl border border-[#29362a] bg-[#0f1610]/92 p-4 shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#92a08f]">Published</div>
          <div className="mt-2 text-3xl font-semibold text-white">{publishedCount}</div>
        </div>
        <div className="rounded-2xl border border-[#29362a] bg-[#0f1610]/92 p-4 shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#92a08f]">Draft</div>
          <div className="mt-2 text-3xl font-semibold text-white">{draftCount}</div>
        </div>
      </div>

      <WorkflowGuidePanel
        title="Instructor Workflow"
        subtitle="Recommended sequence for course production and release."
        steps={[
          {
            title: "Plan",
            description: "Create the course shell, set level/category, and define pricing and launch status.",
          },
          {
            title: "Build",
            description: "Add modules and lectures, upload media keys, and review preview lecture visibility.",
          },
          {
            title: "Release",
            description: "Publish only after quality checks and iterate modules without breaking learner access.",
          },
        ]}
      />

      {loading && <p className="mt-5 text-sm text-[#b7c0b0]">Loading dashboard...</p>}
      {error && <p className="mt-5 text-sm text-red-400">{error}</p>}
      <div className="mt-5 grid gap-4">
        {courses.map((course) => (
          <div
            key={course.id}
            className="grid gap-4 rounded-2xl border border-[#2a332d] bg-[#0f1310]/92 p-5 shadow-[0_12px_28px_rgba(0,0,0,0.22)] sm:grid-cols-[1fr_auto] sm:items-center"
          >
            <div>
              <h3 className="text-lg font-semibold text-white">{course.title}</h3>
              <p className="mt-1 text-sm text-[#b7c0b0]">
                {course.is_published ? "Published" : "Draft"} · {formatINR(course.price)}
              </p>
            </div>
            <div className="grid gap-2 sm:w-[180px]">
              <Link to={`/courses/${course.id}`}>
                <Button variant="secondary" className="w-full">
                  View
                </Button>
              </Link>
              <Link to={`/instructor/courses/${course.id}/edit`}>
                <Button className="w-full">Edit</Button>
              </Link>
            </div>
          </div>
        ))}
        {!loading && !error && courses.length === 0 && (
          <div className="rounded-2xl border border-[#2a332d] bg-[#0f1310]/92 p-6 text-sm text-[#b7c0b0]">
            No courses yet. Create your first course.
          </div>
        )}
      </div>
    </PageShell>
  );
}

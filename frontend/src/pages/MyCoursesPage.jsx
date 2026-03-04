import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getMyCourses } from "../api/courses";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { apiData, apiMessage } from "../utils/api";

export default function MyCoursesPage() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await getMyCourses();
        if (active) setCourses(apiData(response, []));
      } catch (err) {
        if (active) setError(apiMessage(err, "Failed to load enrolled courses."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <PageShell title="My Courses" subtitle="Your enrolled courses.">
      {loading && <p className="text-sm text-[#b7c0b0]">Loading courses...</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!loading && !error && courses.length === 0 && (
        <div className="rounded-2xl border border-[#2a332d] bg-[#0f1310] p-6">
          <p className="text-sm text-[#b7c0b0]">No enrolled courses yet.</p>
          <Link to="/courses" className="mt-4 inline-block">
            <Button>Browse Courses</Button>
          </Link>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {courses.map((course) => (
          <div key={course.id} className="rounded-2xl border border-[#2a332d] bg-[#0f1310] p-5 shadow-[0_10px_30px_rgba(0,0,0,0.2)]">
            <h3 className="text-lg font-semibold">{course.title}</h3>
            <p className="mt-2 text-sm text-[#b7c0b0] line-clamp-3">{course.description}</p>
            <Link to={`/learn/${course.id}`} className="mt-4 inline-block">
              <Button>Continue Learning</Button>
            </Link>
          </div>
        ))}
      </div>
    </PageShell>
  );
}


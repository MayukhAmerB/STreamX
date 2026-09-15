import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCourses } from "../api/courses";
import { apiData, apiMessage } from "../utils/api";
import "../components/CourseExperience.css";

export default function StudentCoursesPage() {
  const [courses, setCourses] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    listCourses().then((response) => {
      const data = apiData(response, []);
      if (active) setCourses(data.filter((course) => course.is_enrolled || ["pending", "payment_pending"].includes(course.enrollment_status)));
    }).catch((err) => { if (active) setError(apiMessage(err, "Your courses could not be loaded.")); });
    return () => { active = false; };
  }, []);
  return <div className="course-experience"><div className="eyebrow">Student account</div><h1>Your courses</h1>
    {error && <p className="message" role="alert">{error}</p>}
    {!courses && !error && <p role="status">Loading your courses…</p>}
    {courses?.length === 0 && <p>You have no confirmed or pending course enrollments. <Link to="/courses">Explore the programs.</Link></p>}
    <div className="stack">{courses?.map((course) => <article className="panel" key={course.id}><div className="eyebrow">{course.is_enrolled ? "Active access" : course.enrollment_status === "payment_pending" ? "Installment renewal required" : "Enrollment pending"}</div><h2>{course.title}</h2><p>{course.description}</p><Link className="action" to={course.is_enrolled ? `/learn/${course.id}` : `/courses/${course.id}`}>{course.is_enrolled ? "Continue learning" : "View course"}</Link>{course.is_enrolled && <Link className="action secondary" style={{ marginLeft: 12 }} to={`/courses/${course.id}/live`}>Live classes</Link>}</article>)}</div>
  </div>;
}

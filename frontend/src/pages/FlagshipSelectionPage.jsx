import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCourses } from "../api/courses";
import { apiData, apiMessage } from "../utils/api";
import "../components/CourseExperience.css";

const tracks = [
  { category: "osint", title: "OSINT" },
  { category: "web_pentesting", title: "PENTESTING" },
];

function ProgramBrief({ course, index, title }) {
  const showImage = Boolean(course?.show_course_image && course?.thumbnail);
  if (showImage) {
    return <div className="course-art"><img src={course.thumbnail} alt={course.image_alt || ""} loading="eager" /><span className="art-label">0{index + 1} / {course.duration || "Professional program"}</span></div>;
  }
  return <div className="course-art course-context">
    <span className="art-label">0{index + 1} / Program brief</span>
    <strong>{course?.card_subtitle || title}</strong>
    <dl>
      <div><dt>Duration</dt><dd>{course?.duration || "To be announced"}</dd></div>
      <div><dt>Curriculum</dt><dd>{course?.section_count ? `${course.section_count} modules` : "Structured modules"}</dd></div>
    </dl>
  </div>;
}

export default function FlagshipSelectionPage() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    listCourses().then((response) => {
      const data = apiData(response);
      if (active) setCourses(Array.isArray(data) ? data : data?.results || []);
    }).catch((err) => { if (active) setError(apiMessage(err, "Courses could not be loaded.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <div className="course-experience course-selection">
    <div className="selection-layout">
    <header className="selection-header"><div className="eyebrow">Al Syed Initiative / Professional training</div>
      <h1>Learn practical<br /><span style={{ color: "#a3adb9" }}>skills through</span><br />focused courses.</h1>
      <p>A structured learning platform for intelligence research, web application security and API testing. Expert-led classes. Practical work. Lasting skills.</p>
      <div className="selection-values"><span>Practical<br />learning</span><span>Structured<br />curriculum</span><span>Expert<br />instruction</span></div>
    </header>
    {error && <div className="message" role="alert">{error} <button onClick={() => window.location.reload()}>Retry</button></div>}
    <div className="flagships">{tracks.map((track, index) => {
      const candidates = courses.filter((course) => course.category === track.category);
      const course = candidates.find((item) => item.is_flagship) || candidates.find((item) => item.launch_status === "live" && !item.registration_closed) || candidates[0];
      const Card = course ? Link : "article";
      return <Card className="panel flagship" key={track.category} to={course ? `/courses/${course.id}` : undefined} aria-label={course ? `Explore ${track.title} course` : undefined}>
        <ProgramBrief course={course} index={index} title={track.title} />
        <div className="flagship-content"><h2>{course?.card_title || track.title}</h2>
        <div className="eyebrow">{course?.card_subtitle || "Professional training"}</div><p className="card-description">{course?.card_summary || course?.description || "Explore the course curriculum and learning outcomes."}</p>
        <ul>{(course?.card_highlights || []).map((topic) => <li key={topic}>{topic}</li>)}</ul>
        {course ? <span className="flagship-action">Explore curriculum <span aria-hidden="true">↗</span></span>
          : <p className="flagship-action">{loading ? "Loading course…" : "Course details coming soon"}</p>}
        </div>
      </Card>;
    })}</div>
    </div>
  </div>;
}

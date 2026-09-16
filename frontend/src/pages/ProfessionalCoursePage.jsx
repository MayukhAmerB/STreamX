import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getCourse } from "../api/courses";
import apiClient from "../api/client";
import { apiData, apiMessage } from "../utils/api";
import { useAuth } from "../hooks/useAuth";
import { formatINR } from "../utils/currency";
import CourseReviews from "../components/CourseReviews";
import "../components/CourseExperience.css";

export function getCourseDetailPriceLabel(course) {
  const amount = Number(course?.price || 0);
  return Number.isFinite(amount) && amount > 0 ? formatINR(amount) : "To be announced";
}

export default function ProfessionalCoursePage() {
  const { id } = useParams();
  const { isAuthenticated } = useAuth();
  const [course, setCourse] = useState(null);
  const [experience, setExperience] = useState(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const response = await apiClient.get(`/courses/${id}/experience/`);
    setExperience(apiData(response));
  }, [id]);
  useEffect(() => {
    let active = true; setCourse(null); setExperience(null); setError("");
    Promise.all([getCourse(id), apiClient.get(`/courses/${id}/experience/`)]).then(([details, experienceResponse]) => {
      if (active) { setCourse(apiData(details)); setExperience(apiData(experienceResponse)); }
    }).catch((err) => { if (active) setError(apiMessage(err, "Course could not be loaded.")); });
    return () => { active = false; };
  }, [id, isAuthenticated]);
  if (error) return <div className="course-experience"><p role="alert" className="message">{error}</p><Link to="/">Return to courses</Link></div>;
  if (!course || !experience) return <div className="course-experience" role="status">Loading course…</div>;
  const pentesting = course.category === "web_pentesting";
  const facts = experience.facts;
  const factItems = [["Duration", facts.duration], ["Schedule", facts.schedule], ["Class length", facts.class_length], ["Total classes", facts.total_classes], ["Total hours", facts.total_hours_label || facts.total_hours], ["Batch size", facts.batch_size_label || facts.batch_size]];
  const showImage = Boolean(course.show_course_image && course.thumbnail);
  const open = course.launch_status === "live" && !course.registration_closed;
  const priceLabel = getCourseDetailPriceLabel(course);
  const action = course.is_enrolled ? <Link className="action full" to={`/learn/${id}`}>Continue learning →</Link>
    : open && (pentesting || course.purchase_available) ? <Link className="action full" to={`/courses/${id}/${pentesting ? "register" : "payment"}`}>{pentesting ? "Apply Now" : "Buy Now"} →</Link>
      : <><button className="action full" disabled>{course.registration_closed ? "Registration closed" : pentesting ? "Applications opening soon" : "Buy Now - opening soon"}</button><Link className="muted" to="/contact">Contact the team for updates</Link></>;
  return <div className="course-experience">
    <Link className="eyebrow" to="/">← All programs</Link>
    <header className={`course-heading visual-course-heading${showImage ? " has-image" : ""}`}>
      {showImage && <img className="course-hero-art" src={course.thumbnail} alt={course.image_alt || ""} />}
      <div className="course-heading-content"><div className="eyebrow" style={{ marginTop: 32 }}>{pentesting ? "Pentesting professional training" : "OSINT professional training program"}</div>
      <h1>{course.title}{facts.batch && !course.title.toLowerCase().includes(facts.batch.toLowerCase()) ? ` (${facts.batch})` : ""}</h1><p>{course.description}</p>
      <dl className="facts hero-facts">{factItems.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "To be announced"}</dd></div>)}</dl>
      <div className="stat"><strong>{experience.enrolled_students.toLocaleString()}</strong><div><div className="eyebrow">Enrolled students</div><div className="muted">Confirmed enrollments · all time for this course</div></div></div>
      <div className="mobile-enrollment">{action}</div>
      </div>
    </header>
    <div className="course-grid"><div className="stack">
      <section className="panel"><div className="eyebrow">Course overview</div><h2>Build knowledge. Put it into practice.</h2>
        <p style={{ whiteSpace: "pre-line" }}>{course.course_overview || course.about_the_course || course.description}</p>
        <h3>What you’ll learn</h3>{course.what_you_will_learn?.length ? <ul>{course.what_you_will_learn.map((topic, index) => <li key={index}>{topic}</li>)}</ul> : <p>See the module descriptions below for the published learning outcomes.</p>}
      </section>
      <section className="panel"><div className="eyebrow">Included with the program</div><h2>What students get</h2><div className="benefits">{(course.course_card_features || []).map((feature, index) => <div className="benefit" key={index}><h3>{feature.title}</h3><p className="muted">{feature.description}</p></div>)}</div></section>
      <section className="panel" id="curriculum"><div className="eyebrow">Learning pathway</div><h2>Course modules</h2><p className="muted">Expand a module to explore its topics and lessons.</p>
        {experience.modules.length ? experience.modules.map((module, index) => <details key={module.id}><summary><span>{String(index + 1).padStart(2, "0")}</span>{module.title}</summary><div className="module-body"><p>{module.description}</p><ul>{module.topics.map((topic, topicIndex) => <li key={topicIndex}>{topic}</li>)}{module.lessons.map((lesson, lessonIndex) => <li key={`lesson-${lessonIndex}`}><strong>{lesson.title}</strong>{lesson.description && <p className="muted">{lesson.description}</p>}</li>)}</ul>{!module.topics.length && !module.lessons.length && <p className="muted">Detailed lesson topics will be announced.</p>}</div></details>) : <p>The curriculum is being prepared. Contact the team for details before enrolling.</p>}
      </section>
      {!!course.expected_outcomes?.length && <section className="panel"><h2>Expected outcomes</h2><ul>{course.expected_outcomes.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
      <CourseReviews key={`${id}-${isAuthenticated}`} courseId={id} experience={experience} refresh={refresh} />
    </div><aside className="panel enroll-panel"><div className="eyebrow">Your next step</div><h2>{course.is_enrolled ? "Your course" : pentesting ? "Apply for the program" : "Buy the course"}</h2>
      <p>{course.enrollment_message || (pentesting ? "Complete a short application. Review your details before continuing to the fee and payment stage." : "Review the course fee, then continue securely to choose an available payment plan.")}</p>
      {!course.is_enrolled ? <div className="course-detail-price"><span>Course fee</span><strong>{priceLabel}</strong></div> : null}
      {action}
      {course.is_enrolled && <Link className="action secondary full" to={`/courses/${id}/live`}>Live classes</Link>}
      <p className="muted" style={{ marginTop: 24 }}>Questions before joining? <Link to="/contact" style={{ textDecoration: "underline" }}>Contact our team</Link>.</p>
      <a className="muted" href="#reviews">{experience.review_count ? `${experience.average_rating} / 5 · ${experience.review_count} reviews` : "Read student reviews"}</a>
    </aside></div>
  </div>;
}

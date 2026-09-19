import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import apiClient from "../api/client";
import { getCourse } from "../api/courses";
import CourseReviews from "../components/CourseReviews";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { formatINR } from "../utils/currency";
import "../components/CourseExperience.css";

const CATEGORY_META = {
  osint: {
    label: "OSINT",
    longLabel: "Open Source Intelligence",
    shortMark: "OS",
    heroImage: "/course-art/osint-detail-operations-v1.png",
    supportImage: "/course-art/osint-program-v2.png",
    visualEyebrow: "Investigation environment",
    visualTitle: "From scattered public data to verified intelligence",
  },
  web_pentesting: {
    label: "Pentesting",
    longLabel: "Web Application & API Security",
    shortMark: "PT",
    heroImage: "/course-art/pentesting-detail-lab-v1.png",
    supportImage: "/course-art/pentesting-program-v2.png",
    visualEyebrow: "Authorized security lab",
    visualTitle: "Learn the workflow behind professional application testing",
  },
};

export function getCourseDetailPriceLabel(course) {
  const amount = Number(course?.price || 0);
  return Number.isFinite(amount) && amount > 0 ? formatINR(amount) : "To be announced";
}

export function shouldShowCoursePrice(course) {
  return (
    !course?.is_enrolled &&
    course?.launch_status === "live" &&
    !course?.registration_closed
  );
}

export function getCourseCatalogPath(course) {
  const category = String(course?.category || "");
  return CATEGORY_META[category] ? `/courses?category=${category}` : "/courses";
}

export function formatCourseStartDate(value) {
  if (!value) return "To be announced";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "To be announced";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function getCourseDetailArtwork(course) {
  const category = CATEGORY_META[course?.category] || CATEGORY_META.osint;
  if (course?.show_course_image && String(course?.thumbnail || "").trim()) {
    return course.thumbnail;
  }
  return category.heroImage;
}

function SectionHeading({ number, eyebrow, title, description }) {
  return (
    <div className="detail-section-heading">
      <span className="detail-section-number" aria-hidden="true">
        {number}
      </span>
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        {description ? <p className="detail-section-description">{description}</p> : null}
      </div>
    </div>
  );
}

function CourseArtwork({ course, category, showImage }) {
  return (
    <img
      className="detail-hero-art"
      src={getCourseDetailArtwork(course)}
      alt={
        showImage
          ? course.image_alt || `${course.title} course artwork`
          : `${category.longLabel} professional learning environment`
      }
    />
  );
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
    let active = true;
    setCourse(null);
    setExperience(null);
    setError("");

    Promise.all([getCourse(id), apiClient.get(`/courses/${id}/experience/`)])
      .then(([details, experienceResponse]) => {
        if (active) {
          setCourse(apiData(details));
          setExperience(apiData(experienceResponse));
        }
      })
      .catch((err) => {
        if (active) setError(apiMessage(err, "Course could not be loaded."));
      });

    return () => {
      active = false;
    };
  }, [id, isAuthenticated]);

  if (error) {
    return (
      <div className="course-experience">
        <p role="alert" className="message">
          {error}
        </p>
        <Link to="/courses">Return to courses</Link>
      </div>
    );
  }

  if (!course || !experience) {
    return (
      <div className="course-experience" role="status">
        Loading course...
      </div>
    );
  }

  const pentesting = course.category === "web_pentesting";
  const category = CATEGORY_META[course.category] || CATEGORY_META.osint;
  const facts = experience.facts || {};
  const modules = Array.isArray(experience.modules) ? experience.modules : [];
  const benefits = Array.isArray(course.course_card_features) ? course.course_card_features : [];
  const learningOutcomes = Array.isArray(course.what_you_will_learn)
    ? course.what_you_will_learn
    : [];
  const expectedOutcomes = Array.isArray(course.expected_outcomes)
    ? course.expected_outcomes
    : [];
  const showImage = Boolean(course.show_course_image && course.thumbnail);
  const open = course.launch_status === "live" && !course.registration_closed;
  const courseStatusLabel = course.is_enrolled
    ? "Course unlocked"
    : course.registration_closed
      ? "Registration closed"
      : course.launch_status === "live"
        ? "Admissions open"
        : "Coming soon";
  const priceLabel = getCourseDetailPriceLabel(course);
  const instructorName =
    course.snapshot_instructor || course.instructor?.full_name || "Al Syed Initiative faculty";
  const courseTitle =
    facts.batch && !course.title.toLowerCase().includes(String(facts.batch).toLowerCase())
      ? `${course.title} (${facts.batch})`
      : course.title;
  const ratingLabel =
    experience.average_rating === null ? "New course" : `${experience.average_rating} / 5`;
  const totalLessons = modules.reduce(
    (total, module) => total + (Array.isArray(module.lessons) ? module.lessons.length : 0),
    0
  );
  const totalTopics = modules.reduce(
    (total, module) => total + (Array.isArray(module.topics) ? module.topics.length : 0),
    0
  );
  const focusAreas = (
    Array.isArray(course.card_highlights) && course.card_highlights.length
      ? course.card_highlights
      : learningOutcomes
  ).slice(0, 4);
  const factItems = [
    ["Duration", facts.duration],
    ["Schedule", facts.schedule],
    ["Class length", facts.class_length],
    ["Total classes", facts.total_classes],
    ["Learning hours", facts.total_hours_label || facts.total_hours],
    ["Batch size", facts.batch_size_label || facts.batch_size],
  ];

  const action = course.is_enrolled ? (
    <Link className="action full" to={`/learn/${id}`}>
      Continue learning <span aria-hidden="true">&rarr;</span>
    </Link>
  ) : open && (pentesting || course.purchase_available) ? (
    <Link
      className="action full"
      to={`/courses/${id}/${pentesting ? "register" : "payment"}`}
    >
      {pentesting ? "Apply now" : "Buy now"} <span aria-hidden="true">&rarr;</span>
    </Link>
  ) : (
    <>
      <button className="action full" disabled>
        {course.registration_closed
          ? "Registration closed"
          : pentesting
            ? "Applications opening soon"
            : "Buy now - opening soon"}
      </button>
      <Link className="muted detail-contact-link" to="/contact">
        Contact the team for updates
      </Link>
    </>
  );

  return (
    <main className="course-experience course-detail-v2">
      <nav className="detail-topline" aria-label="Course navigation">
        <Link className="detail-back-link" to={getCourseCatalogPath(course)}>
          <span aria-hidden="true">&larr;</span> All {category.label} courses
        </Link>
        <span className={`detail-status ${open || course.is_enrolled ? "is-open" : ""}`}>
          <span aria-hidden="true" />
          {courseStatusLabel}
        </span>
      </nav>

      <header className={`detail-hero${showImage ? " has-image" : ""}`}>
        <div className="detail-hero-copy">
          <div className="detail-hero-labels">
            <span>{category.label}</span>
            <span>{String(course.level || "Professional").replace("_", " ")}</span>
          </div>
          <p className="detail-program-name">{category.longLabel}</p>
          <h1>{courseTitle}</h1>
          <p className="detail-hero-description">{course.description}</p>

          <div className="detail-proof-row" aria-label="Course trust indicators">
            <div>
              <strong>{ratingLabel}</strong>
              <span>
                {experience.review_count
                  ? `${experience.review_count} verified reviews`
                  : "First cohort"}
              </span>
            </div>
            <div>
              <strong>{Number(experience.enrolled_students || 0).toLocaleString()}</strong>
              <span>Confirmed students</span>
            </div>
            <div>
              <strong>{modules.length}</strong>
              <span>Curriculum modules</span>
            </div>
          </div>
        </div>

        <div className="detail-hero-visual">
          <CourseArtwork course={course} category={category} showImage={showImage} />
          <div className="detail-art-scrim" />
          <div className="detail-art-caption">
            <span>Led by</span>
            <strong>{instructorName}</strong>
          </div>
        </div>

        <dl className="detail-fact-strip">
          {factItems.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value === 0 || value ? value : "To be announced"}</dd>
            </div>
          ))}
        </dl>
      </header>

      <section className="detail-program-dashboard" aria-label="Program at a glance">
        <figure className="detail-program-visual">
          <img
            src={category.supportImage}
            alt={`${category.label} course learning environment`}
          />
          <div className="detail-program-visual-scrim" />
          <figcaption>
            <span>{category.visualEyebrow}</span>
            <strong>{category.visualTitle}</strong>
          </figcaption>
        </figure>

        <div className="detail-program-intelligence">
          <div className="detail-intelligence-heading">
            <div>
              <span className="eyebrow">Program intelligence</span>
              <h2>A complete view before you enroll</h2>
            </div>
            <span className="detail-program-code">{category.shortMark} / {facts.batch || "Current"}</span>
          </div>

          <div className="detail-intelligence-metrics">
            <div>
              <strong>{modules.length}</strong>
              <span>Published modules</span>
            </div>
            <div>
              <strong>{totalLessons}</strong>
              <span>Detailed lessons</span>
            </div>
            <div>
              <strong>{totalTopics}</strong>
              <span>Mapped topics</span>
            </div>
            <div>
              <strong>{facts.total_classes || "TBA"}</strong>
              <span>Live classes</span>
            </div>
          </div>

          <div className="detail-program-context">
            <div>
              <span>Instructor</span>
              <strong>{instructorName}</strong>
            </div>
            <div>
              <span>Next start</span>
              <strong>{formatCourseStartDate(facts.start_date)}</strong>
            </div>
            <div>
              <span>Learning level</span>
              <strong>{course.snapshot_level || course.level || "Professional"}</strong>
            </div>
          </div>

          {focusAreas.length ? (
            <div className="detail-focus-areas">
              <span className="eyebrow">Key focus areas</span>
              <div>
                {focusAreas.map((area, index) => (
                  <span key={`${area}-${index}`}>{area}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <div className="course-grid detail-layout">
        <div className="stack detail-content-stack">
          <section className="panel detail-section detail-overview-panel">
            <SectionHeading
              number="01"
              eyebrow="Course overview"
              title="Build knowledge. Put it into practice."
              description="A focused learning path designed around useful, repeatable professional skills."
            />
            <div className="detail-overview-grid">
              <p className="detail-long-copy" style={{ whiteSpace: "pre-line" }}>
                {course.course_overview || course.about_the_course || course.description}
              </p>
              <div className="detail-learning-list">
                <h3>What you will learn</h3>
                {learningOutcomes.length ? (
                  <ul>
                    {learningOutcomes.map((topic, index) => (
                      <li key={index}>
                        <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                        {topic}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Published learning outcomes are detailed in the curriculum below.</p>
                )}
              </div>
            </div>
          </section>

          <section className="panel detail-section">
            <SectionHeading
              number="02"
              eyebrow="Program experience"
              title="Everything included"
              description="Course benefits and delivery details configured by the academic team."
            />
            <div className="benefits detail-benefit-grid">
              {benefits.map((feature, index) => (
                <article className="benefit detail-benefit-card" key={`${feature.title}-${index}`}>
                  <span className="detail-benefit-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{feature.title}</h3>
                  <p className="muted">{feature.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="panel detail-section detail-curriculum" id="curriculum">
            <SectionHeading
              number="03"
              eyebrow="Learning pathway"
              title="Course curriculum"
              description="Open a module to review its published topics and lesson plan."
            />
            <div className="detail-module-list">
              {modules.length ? (
                modules.map((module, index) => {
                  const lessonCount = module.topics.length + module.lessons.length;
                  return (
                    <details key={module.id}>
                      <summary>
                        <span className="detail-module-index">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="detail-module-title">{module.title}</span>
                        <span className="detail-module-count">
                          {lessonCount} item{lessonCount === 1 ? "" : "s"}
                        </span>
                        <span className="detail-module-toggle" aria-hidden="true">
                          +
                        </span>
                      </summary>
                      <div className="module-body">
                        {module.description ? <p>{module.description}</p> : null}
                        <ul>
                          {module.topics.map((topic, topicIndex) => (
                            <li key={topicIndex}>{topic}</li>
                          ))}
                          {module.lessons.map((lesson, lessonIndex) => (
                            <li key={`lesson-${lessonIndex}`}>
                              <strong>{lesson.title}</strong>
                              {lesson.description ? (
                                <p className="muted">{lesson.description}</p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                        {!module.topics.length && !module.lessons.length ? (
                          <p className="muted">Detailed lesson topics will be announced.</p>
                        ) : null}
                      </div>
                    </details>
                  );
                })
              ) : (
                <p>
                  The curriculum is being prepared. Contact the team for details before enrolling.
                </p>
              )}
            </div>
          </section>

          {expectedOutcomes.length ? (
            <section className="panel detail-section detail-outcomes">
              <SectionHeading
                number="04"
                eyebrow="Professional outcomes"
                title="What you can take forward"
                description="Practical capabilities students should be able to demonstrate after completion."
              />
              <ol>
                {expectedOutcomes.map((item, index) => (
                  <li key={index}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <p>{item}</p>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <CourseReviews
            key={`${id}-${isAuthenticated}`}
            courseId={id}
            experience={experience}
            refresh={refresh}
          />
        </div>

        <aside className="panel enroll-panel detail-enroll-panel">
          <div className="detail-enroll-topline">
            <span className="eyebrow">Your next step</span>
            <span className="detail-enroll-status">
              {course.is_enrolled ? "Unlocked" : open ? "Open" : "Updates"}
            </span>
          </div>
          <h2>
            {course.is_enrolled
              ? "Continue your course"
              : pentesting
                ? "Apply for the program"
                : "Enroll in this course"}
          </h2>
          <p>
            {course.enrollment_message ||
              (pentesting
                ? "Complete a short application, review your details, and then continue to the available payment stage."
                : "Review the course fee and continue securely to the available payment options.")}
          </p>

          {shouldShowCoursePrice(course) ? (
            <div className="course-detail-price">
              <span>Course fee</span>
              <strong>{priceLabel}</strong>
            </div>
          ) : null}

          {action}

          {course.is_enrolled ? (
            <Link className="action secondary full" to={`/courses/${id}/live`}>
              Live classes
            </Link>
          ) : null}

          <dl className="detail-enroll-facts">
            <div>
              <dt>Starts</dt>
              <dd>{formatCourseStartDate(facts.start_date)}</dd>
            </div>
            <div>
              <dt>Instructor</dt>
              <dd>{instructorName}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>{facts.schedule || "Structured professional training"}</dd>
            </div>
          </dl>

          {benefits.length ? (
            <div className="detail-included-list">
              <span className="eyebrow">Included</span>
              <ul>
                {benefits.slice(0, 3).map((feature, index) => (
                  <li key={`${feature.title}-${index}`}>{feature.title}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="detail-enroll-footer">
            <a href="#reviews">
              {experience.review_count
                ? `${experience.average_rating} / 5 from ${experience.review_count} reviews`
                : "Read student reviews"}
            </a>
            <Link to="/contact">Ask a question</Link>
          </div>
        </aside>
      </div>
    </main>
  );
}

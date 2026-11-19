// /courses/:id (PHILOSOPHY T4, BUILD_PLAN §2.1): track-page hero + lesson
// outline. Data and actions unchanged (GET /api/courses/:id/ and
// /experience/, reviews, hash scroll, Continue learning, installments, Buy /
// Apply). Pentesting (owner rule): the course and its module outline are
// browsable, and every enrol/apply/buy control is disabled with the server's
// reason while the `pentesting` switch is off (the server answers 403
// feature_disabled meanwhile).
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";

import apiClient from "../api/client";
import { getCourse } from "../api/courses";
import CourseReviews from "../components/CourseReviews";
import { configuredCourseFeeLabel } from "../components/payments/paymentPlans";
import { useAuth } from "../hooks/useAuth";
import { coursePurchaseGate, pentestingGate, useCatalog } from "../marketing/catalogApi";
import LineArt, { lineArtFor } from "../marketing/LineArt";
import { ButtonLink, CheckList, ClockIcon, DisabledAction, InfoIcon, Kicker, StatusPill } from "../marketing/primitives";
import { tierOf, PENTESTING_TIERS } from "../marketing/tiers";
import { apiData, apiMessage } from "../utils/api";
import { formatINR } from "../utils/currency";
import { normalizeTextList } from "../utils/textList";
import "../components/CourseExperience.css";

const CATEGORY_META = {
  osint: {
    label: "OSINT",
    longLabel: "Open Source Intelligence",
    heroImage: "/course-art/osint-detail-operations-v1.webp",
  },
  web_pentesting: {
    label: "Pentesting",
    longLabel: "Pentesting",
    heroImage: "/course-art/pentesting-detail-lab-v1.webp",
  },
};

export function getCourseDetailPriceLabel(course) {
  const configured = configuredCourseFeeLabel(course);
  if (configured) return configured;
  const amount = Number(course?.price || 0);
  return Number.isFinite(amount) && amount > 0 ? formatINR(amount) : "To be announced";
}

export function shouldShowCoursePrice(course) {
  return !course?.is_enrolled && course?.launch_status === "live" && !course?.registration_closed;
}

export function getCourseCatalogPath(course) {
  const category = String(course?.category || "");
  return CATEGORY_META[category] ? `/courses?category=${category}` : "/courses";
}

export function formatCourseStartDate(value) {
  if (!value) return "To be announced";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "To be announced";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function getCourseDetailArtwork(course) {
  const category = CATEGORY_META[course?.category] || CATEGORY_META.osint;
  if (course?.show_course_image && String(course?.thumbnail || "").trim()) {
    return course.thumbnail;
  }
  return category.heroImage;
}

export function scrollToCourseHash(hash, documentRef = document) {
  let targetId = "";
  try {
    targetId = decodeURIComponent(String(hash || "").replace(/^#/, ""));
  } catch {
    return false;
  }
  if (!targetId) return false;
  const target = documentRef.getElementById(targetId);
  if (!target) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.focus?.({ preventScroll: true });
  return true;
}

/**
 * The enrol/buy/apply block. `gate` is coursePurchaseGate(): when it is
 * disabled (Pentesting while the switch is off, or the server's
 * purchase_gate), every acquisition control is a DisabledAction with the reason.
 */
export function CourseActions({ course, id, gate }) {
  const pentesting = course.category === "web_pentesting";
  const open = course.launch_status === "live" && !course.registration_closed;
  if (course.is_enrolled) {
    return (
      <div className="hp-actions">
        <ButtonLink to={`/learn/${id}`} variant="primary" size="lg" arrow>
          Continue learning
        </ButtonLink>
        <ButtonLink to={`/courses/${id}/live`} variant="secondary" size="lg">
          Live classes
        </ButtonLink>
        {course.enrollment_access_type === "installment" ? (
          <ButtonLink to={`/courses/${id}/payment`} variant="secondary" size="lg" arrow>
            Pay next installment
          </ButtonLink>
        ) : null}
      </div>
    );
  }
  if (gate.disabled) {
    return (
      <div className="hp-actions" data-purchase-state={gate.state}>
        <DisabledAction label="Enrol (coming soon)" reason={gate.reason || "Enrolment opens at launch."} size="lg" />
        <ButtonLink to="#curriculum" variant="secondary" size="lg">
          Browse the outline
        </ButtonLink>
      </div>
    );
  }
  // Pentesting checks out exactly like OSINT: straight to plan and payment.
  if (open && course.purchase_available) {
    return (
      <div className="hp-actions">
        <ButtonLink to={`/courses/${id}/payment`} variant="primary" size="lg" arrow>
          Buy now
        </ButtonLink>
        <ButtonLink to="#curriculum" variant="secondary" size="lg">
          See the curriculum
        </ButtonLink>
      </div>
    );
  }
  return (
    <div className="hp-actions">
      <DisabledAction
        label={course.registration_closed ? "Registration closed" : pentesting ? "Applications opening soon" : "Buy now - opening soon"}
        reason="Contact the team for updates."
        size="lg"
      />
      <ButtonLink to="/contact" variant="secondary" size="lg">
        Contact the team
      </ButtonLink>
    </div>
  );
}

function statusOf(course, gate) {
  if (course.is_enrolled) return { kind: "open", label: "Course unlocked" };
  if (gate.disabled && gate.code === "feature_disabled") return { kind: "soon", label: "Coming soon" };
  if (course.registration_closed) return { kind: "closed", label: "Registration closed" };
  if (course.launch_status === "live") return { kind: "open", label: "Admissions open" };
  return { kind: "soon", label: "Coming soon" };
}

export default function ProfessionalCoursePage() {
  const { id } = useParams();
  const { hash } = useLocation();
  const { isAuthenticated } = useAuth();
  const catalog = useCatalog();
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

  useEffect(() => {
    if (!course || !experience || !hash) return undefined;
    const frame = window.requestAnimationFrame(() => scrollToCourseHash(hash));
    return () => window.cancelAnimationFrame(frame);
  }, [course, experience, hash]);

  if (error) {
    return (
      <div className="hp-frame hp-detail">
        <p role="alert" className="hp-reason">
          {error}
        </p>
        <p style={{ marginTop: 16 }}>
          <Link className="hp-text-link" to="/courses">
            Return to courses
          </Link>
        </p>
      </div>
    );
  }

  if (!course || !experience) {
    return (
      // Hold the page's height while loading so the footer does not jump (CLS).
      <div className="hp-frame hp-detail min-h-[100svh]" role="status">
        <p className="hp-body">Loading course…</p>
      </div>
    );
  }

  const pentesting = course.category === "web_pentesting";
  const category = CATEGORY_META[course.category] || CATEGORY_META.osint;
  const gate = coursePurchaseGate(course, pentesting ? pentestingGate(catalog, []) : null);
  const status = statusOf(course, gate);
  const facts = experience.facts || {};
  const modules = Array.isArray(experience.modules) ? experience.modules : [];
  const benefits = Array.isArray(course.course_card_features) ? course.course_card_features : [];
  const learningOutcomes = normalizeTextList(course.what_you_will_learn);
  const expectedOutcomes = normalizeTextList(course.expected_outcomes);
  const showImage = Boolean(course.show_course_image && course.thumbnail);
  const priceLabel = getCourseDetailPriceLabel(course);
  const instructorName = course.snapshot_instructor || course.instructor?.full_name || "Al Syed Initiative faculty";
  const courseTitle =
    facts.batch && !course.title.toLowerCase().includes(String(facts.batch).toLowerCase()) ? `${course.title} (${facts.batch})` : course.title;
  const tierKey = tierOf(course);
  const tierLabel = course.tier_label || PENTESTING_TIERS.find((tier) => tier.key === tierKey)?.label || "";
  const ratingLabel = experience.average_rating === null ? "New course" : `${experience.average_rating} / 5`;
  const factItems = [
    ["Duration", facts.duration],
    ["Schedule", facts.schedule],
    ["Class length", facts.class_length],
    ["Total classes", facts.total_classes],
    ["Learning hours", facts.total_hours_label || facts.total_hours],
    ["Batch size", facts.batch_size_label || facts.batch_size],
  ].filter(([, value]) => value === 0 || value);

  return (
    <div className="hp-frame hp-detail course-detail-hp" data-course-category={course.category}>
      <nav aria-label="Course navigation">
        <Link className="hp-detail__back hp-text-link" to={pentesting ? "/tracks/pentesting" : getCourseCatalogPath(course)}>
          <span aria-hidden="true">←</span> {pentesting ? "All Pentesting tiers" : `All ${category.label} courses`}
        </Link>
      </nav>

      <header className="hp-detail__hero">
        <div>
          <Kicker lead={category.label} rest={tierLabel || String(course.level || "Professional").replace("_", " ")} />
          <h1 className="hp-detail__h1">{courseTitle}</h1>
          <p className="hp-detail__lead">{course.card_summary || course.description}</p>
          <p className="hp-detail__note">
            {gate.disabled && gate.code === "feature_disabled" ? <ClockIcon /> : <InfoIcon />}
            <span>
              <StatusPill kind={status.kind}>{status.label}</StatusPill>{" "}
              {gate.disabled && gate.code === "feature_disabled" ? "Browse every module now; enrolment opens at launch." : null}
            </span>
          </p>
          <p className="hp-detail__meta">
            <span>{modules.length} modules</span>
            {facts.total_hours_label || facts.total_hours ? <span>{facts.total_hours_label || `${facts.total_hours} hours`}</span> : null}
            <span>{course.snapshot_level || String(course.level || "Professional").replace("_", " ")}</span>
            <span>Starts {formatCourseStartDate(facts.start_date)}</span>
          </p>
          {shouldShowCoursePrice(course) && !gate.disabled ? (
            <p className="hp-detail__price">
              <span className="hp-eyebrow">Course fee</span>
              <strong>{priceLabel}</strong>
            </p>
          ) : null}
          <div className="hp-detail__actions">
            <CourseActions course={course} id={id} gate={gate} />
          </div>
          <p className="hp-detail__fine">
            {course.enrollment_message ||
              (pentesting
                ? "Applications are reviewed by the team before the payment stage."
                : "Review the course fee and continue securely to the available payment options.")}{" "}
            <Link to="/contact">Ask a question</Link>
          </p>
        </div>
        <figure className="hp-detail__art">
          {showImage ? (
            <img src={getCourseDetailArtwork(course)} alt={course.image_alt || `${course.title} course artwork`} width="1280" height="720" decoding="async" fetchpriority="high" />
          ) : (
            <LineArt name={lineArtFor(course)} />
          )}
          <figcaption className="hp-detail__caption">Led by {instructorName}</figcaption>
        </figure>
      </header>

      {factItems.length ? (
        <dl className="hp-stats hp-stats--wide" style={{ "--hp-stats-n": Math.min(factItems.length, 6), marginTop: 40 }} aria-label="Course facts">
          {factItems.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="hp-detail__body">
        <aside className="hp-detail__sticky">
          <Kicker lead="Your path" />
          <h2>Course curriculum</h2>
          <p className="hp-body" style={{ marginTop: 12 }}>
            Open a module to read its topics and lesson plan.
          </p>
          <p className="hp-detail__figure">
            {modules.length} <small>modules</small>
          </p>
          <p className="hp-meta" style={{ marginTop: 8 }}>
            {ratingLabel} · {experience.review_count ? `${experience.review_count} verified reviews` : "First cohort"} ·{" "}
            {Number(experience.enrolled_students || 0).toLocaleString()} students
          </p>
        </aside>

        <div>
          <section className="hp-detail__section" id="curriculum" tabIndex={-1} aria-labelledby="hp-curriculum-title">
            <p className="hp-chapter" id="hp-curriculum-title">
              Module outline
            </p>
            {modules.length ? (
              <div className="hp-outline">
                {modules.map((module, index) => {
                  const moduleTopics = normalizeTextList(module.topics);
                  const moduleLessons = Array.isArray(module.lessons) ? module.lessons : [];
                  const lessonCount = moduleTopics.length + moduleLessons.length;
                  return (
                    <details key={module.id || index} className="hp-module">
                      <summary>
                        <span className="hp-module__index">
                          Module <b>{String(index + 1).padStart(2, "0")}</b>
                        </span>
                        <span>
                          <span className="hp-module__title">{module.title}</span>
                          {module.description ? <span className="hp-module__desc">{module.description}</span> : null}
                        </span>
                        <span className="hp-module__count">
                          {lessonCount} item{lessonCount === 1 ? "" : "s"}
                        </span>
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                          <path d="m4 6 4 4 4-4" />
                        </svg>
                      </summary>
                      <div className="hp-module__body">
                        {module.description ? <p>{module.description}</p> : null}
                        {lessonCount ? (
                          <ul>
                            {moduleTopics.map((topic, topicIndex) => (
                              <li key={topicIndex}>{topic}</li>
                            ))}
                            {moduleLessons.map((lesson, lessonIndex) => (
                              <li key={`lesson-${lessonIndex}`}>
                                <strong>{lesson.title}</strong>
                                {lesson.description ? <span className="hp-module__desc">{lesson.description}</span> : null}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>Detailed lesson topics will be announced.</p>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            ) : (
              <p className="hp-body">The curriculum is being prepared. Contact the team for details before enrolling.</p>
            )}
          </section>

          <section className="hp-detail__section" aria-labelledby="hp-overview-title">
            <p className="hp-chapter" id="hp-overview-title">
              About this course
            </p>
            <p className="hp-detail__lead" style={{ marginTop: 0 }}>
              {course.course_overview || course.about_the_course || course.description}
            </p>
          </section>

          {learningOutcomes.length ? (
            <section className="hp-detail__section" aria-labelledby="hp-learn-title">
              <p className="hp-chapter" id="hp-learn-title">
                What you will be able to do
              </p>
              <CheckList items={learningOutcomes.map((text) => ({ text }))} />
            </section>
          ) : null}

          {benefits.length ? (
            <section className="hp-detail__section" aria-labelledby="hp-included-title">
              <p className="hp-chapter" id="hp-included-title">
                Everything included
              </p>
              <ul className="hp-cols" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
                {benefits.map((feature, index) => (
                  <li key={`${feature.title}-${index}`}>
                    <h3>{feature.title}</h3>
                    <p>{feature.description}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {expectedOutcomes.length ? (
            <section className="hp-detail__section" aria-labelledby="hp-outcomes-title">
              <p className="hp-chapter" id="hp-outcomes-title">
                What you can take forward
              </p>
              <CheckList items={expectedOutcomes.map((text) => ({ text }))} />
            </section>
          ) : null}

          <section className="hp-detail__section course-experience hp-reviews">
            <CourseReviews key={`${id}-${isAuthenticated}`} courseId={id} experience={experience} refresh={refresh} />
          </section>
        </div>
      </div>
    </div>
  );
}

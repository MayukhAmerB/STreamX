import { lazy, memo, Suspense, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";

import { Band, Carousel, Column, EmptyState, InlineNotification, LoadingRegion, Skeleton, Tag } from "../../site-kit";
import { describeTrackAvailability } from "../../utils/catalogTracks";
import { resolveCourseArtwork, resolveCourseArtworkFallback } from "../../utils/courseArtwork";
import { getCourseLaunchStatus } from "../../utils/courseStatus";
import { selectLandingCourses } from "../../utils/landingCourses";
import { ArrowRight, BandHeading } from "./LandingParts";
import { BESTSELLERS_EMPTY } from "./landingContent";

// The enquiry form is only downloaded when someone opens it.
const PublicEnrollmentRequestModal = lazy(() => import("../../components/PublicEnrollmentRequestModal"));

function formatCategory(category) {
  return category === "web_pentesting" ? "Pentesting" : "OSINT";
}

function formatLevel(level) {
  const value = String(level || "").trim();
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "All levels";
}

/** Status per the vocabulary (plan §7.1): Open, Coming soon or Previous batch, never "Live". */
export function courseStatusTag(course) {
  if (course?.registration_closed) return "previous-batch";
  return getCourseLaunchStatus(course).isComingSoon ? "coming-soon" : "open";
}

function StarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="m8 1.5 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
    </svg>
  );
}

/**
 * A Bestsellers card: every field of the previous card, one primary link
 * ("See Details", stretched over the card so the whole card is a target) and
 * the reviews count as a secondary text link (/courses/{id}#reviews).
 */
export const LandingCourseCard = memo(function LandingCourseCard({ course, closedReason = "" }) {
  const courseId = Number(course?.id || 0);
  const reasonId = `lp-course-reason-${courseId || "x"}`;
  const category = course?.category;
  const thumbnail = course?.thumbnail;
  const fallbackArtwork = resolveCourseArtworkFallback(category);
  const [imageSrc, setImageSrc] = useState(() => resolveCourseArtwork(course));
  const title = course?.card_title || course?.title || "Untitled course";
  const detailPath = courseId > 0 ? `/courses/${courseId}` : "/courses";
  const parsedReviews = Number(course?.review_count || 0);
  const reviewCount = Number.isFinite(parsedReviews) ? Math.max(0, Math.trunc(parsedReviews)) : 0;
  const averageRating = Number(course?.average_rating);
  const hasRating = reviewCount > 0 && Number.isFinite(averageRating);
  const hoursLabel =
    course?.total_hours_label || (Number(course?.total_hours || 0) > 0 ? `${course.total_hours} total hours` : course?.duration || "");
  const unitLabel =
    Number(course?.lecture_count || 0) > 0
      ? `${course.lecture_count} lectures`
      : Number(course?.total_classes || 0) > 0
        ? `${course.total_classes} live classes`
        : Number(course?.section_count || 0) > 0
          ? `${course.section_count} modules`
          : "";
  const facts = [hoursLabel, unitLabel, formatLevel(course?.level)].filter(Boolean);

  useEffect(() => {
    setImageSrc(resolveCourseArtwork({ category, thumbnail }));
  }, [category, courseId, thumbnail]);

  return (
    <article className={`lp-course${closedReason ? " lp-course--closed" : ""}`}>
      <div className="lp-course__media">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={course?.image_alt || `${title} course artwork`}
            width="640"
            height="360"
            loading="lazy"
            decoding="async"
            onError={() => setImageSrc(fallbackArtwork && imageSrc !== fallbackArtwork ? fallbackArtwork : "")}
          />
        ) : null}
      </div>
      <div className="lp-course__body">
        <div className="lp-course__tags">
          <Tag size="sm">{formatCategory(category)}</Tag>
          <Tag type={courseStatusTag(course)} size="sm" />
        </div>
        <h3 className="lp-course__title">{title}</h3>
        {course?.instructor?.full_name ? <p className="lp-course__instructor">{course.instructor.full_name}</p> : null}
        <p className="lp-course__rating">
          <span className="lp-course__score">
            {hasRating ? averageRating.toFixed(1) : "New"}
            {hasRating ? <StarIcon /> : null}
          </span>
          {closedReason ? (
            <span className="lp-course__reviews lp-course__reviews--static">
              {reviewCount > 0 ? `(${reviewCount} ${reviewCount === 1 ? "review" : "reviews"})` : "No reviews yet"}
            </span>
          ) : (
            <RouterLink
              to={`${detailPath}#reviews`}
              className="lp-course__reviews"
              aria-label={reviewCount > 0 ? `${reviewCount} verified reviews for ${title}` : `No reviews yet for ${title}`}
            >
              {reviewCount > 0 ? `(${reviewCount} ${reviewCount === 1 ? "review" : "reviews"})` : "No reviews yet"}
            </RouterLink>
          )}
        </p>
        {facts.length ? <p className="lp-course__facts">{facts.join(" · ")}</p> : null}
        <div className="lp-course__footer">
          {closedReason ? (
            <>
              <span id={reasonId} className="lp-course__note">{closedReason}</span>
              {/* Plan §7.2 rule 2: no href, aria-disabled, still focusable so the reason is reachable. */}
              <span
                role="link"
                aria-disabled="true"
                tabIndex={0}
                aria-describedby={reasonId}
                className="lp-course__primary lp-course__primary--disabled"
                aria-label={`See details for ${title} (unavailable)`}
              >
                See Details
              </span>
            </>
          ) : (
            <>
              <span className="lp-course__note">Curriculum &amp; reviews</span>
              <RouterLink to={detailPath} className="lp-course__primary" aria-label={`See details for ${title}`}>
                See Details
                <ArrowRight />
              </RouterLink>
            </>
          )}
        </div>
      </div>
    </article>
  );
});

function CourseSkeletons() {
  return (
    <LoadingRegion label="Loading courses" className="lp-course-skeletons">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="lp-course-skeleton">
          <Skeleton variant="block" height="100%" decorative className="lp-course-skeleton__media" />
          <Skeleton lines={3} decorative />
        </div>
      ))}
    </LoadingRegion>
  );
}

/**
 * The Bestsellers body, shared by the v2 band and the v3 "Open now" band: a
 * carousel (4-up lg, 2-up md, swipe on phones) of the open and upcoming
 * programmes, oldest first. Empty: the kept copy plus the existing enquiry
 * form (owner decision D2). Failure: real cached data with "Last updated",
 * or an error with Retry; never an invented course.
 *
 * `browsableTracks`: v3 (owner rule) keeps coming-soon tracks browsable, so
 * their cards link to the course page instead of rendering disabled.
 */
export function BestsellersContent({ catalog, browsableTracks = false, limit = 0 }) {
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  const all = selectLandingCourses(catalog.courses);
  const courses = limit > 0 ? all.slice(0, limit) : all;
  const loading = catalog.status === "loading";
  const failed = catalog.status === "error";

  let content;
  if (courses.length) {
    content = (
      <Carousel
        label="Courses in first-in, first-out order"
        previousLabel="Scroll courses backward"
        nextLabel="Scroll courses forward"
        toolbar={<span>Oldest programs first</span>}
        perView={{ sm: 1, md: 2, lg: 4 }}
        className="lp-carousel"
      >
        {courses.map((course) => {
          const { closed, reason } = describeTrackAvailability(catalog.tracks, course?.category);
          return <LandingCourseCard key={course.id} course={course} closedReason={closed && !browsableTracks ? reason : ""} />;
        })}
      </Carousel>
    );
  } else if (loading) {
    content = <CourseSkeletons />;
  } else if (!failed) {
    const [first, ...rest] = BESTSELLERS_EMPTY.split(". ");
    content = (
      <EmptyState
        className="lp-empty"
        title={`${first}.`}
        body={rest.join(". ")}
        action={{ label: "Submit an enquiry", onClick: () => setEnquiryOpen(true), kind: "primary" }}
      />
    );
  }

  return (
    <>
      {failed ? (
        <InlineNotification
          kind={courses.length ? "warning" : "error"}
          lowContrast
          title={courses.length ? "Showing the last saved course list." : "Courses could not be loaded."}
          subtitle={courses.length ? "The live catalogue did not respond." : "Check your connection and try again."}
          lastUpdated={courses.length ? catalog.updatedAt : undefined}
          onRetry={catalog.retry}
          className="lp-notice"
        />
      ) : null}
      {content}
      {enquiryOpen ? (
        <Suspense fallback={null}>
          <PublicEnrollmentRequestModal isOpen={enquiryOpen} onClose={() => setEnquiryOpen(false)} sourcePath="/" />
        </Suspense>
      ) : null}
    </>
  );
}

/** Band 2 (v2 page): Bestsellers heading + the shared body. */
export default function BestsellersBand({ theme = "white", catalog }) {
  return (
    <Band theme={theme} className="lp-band lp-bestsellers" labelledBy="lp-bestsellers-title">
      <Column sm={4} md={8} lg={8}>
        <BandHeading
          id="lp-bestsellers-title"
          eyebrow="Our training program"
          title="Bestsellers"
          subtitle="Compare active professional programs, verified learner ratings, curriculum depth, and learning formats before opening the full course page."
        />
      </Column>
      <Column sm={4} md={8} lg={16} className="lp-bestsellers__content">
        <BestsellersContent catalog={catalog} />
      </Column>
    </Band>
  );
}

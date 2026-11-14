import { Link } from "react-router-dom";

import { ArrowRight, Clock } from "./icons";
import { PENTESTING_COMING_SOON_REASON } from "./pentestingGate";

/**
 * Calm "Coming soon" state for a Pentesting course whose purchase, enrolment
 * or application is switched off (admin switch `pentesting`). The action is
 * shown disabled, never hidden: a focusable aria-disabled button points at
 * the visible reason, and the way forward is browsing the course and its
 * module outline. The server refuses the action anyway (403 feature_disabled).
 */
export default function ComingSoonPanel({ course, action = "Enrol", reason = PENTESTING_COMING_SOON_REASON, headingLevel = 2, titleId }) {
  const reasonId = `${titleId || "coming-soon"}-reason`;
  const Heading = `h${headingLevel}`;
  const courseId = course?.id;
  return (
    <div className="au-coming" data-testid="pentesting-coming-soon">
      <div className="au-notice">
        <Clock className="au-notice__icon" />
        <div>
          <p className="au-eyebrow">Coming soon</p>
          <Heading id={titleId} className="au-notice__title">
            {course?.title ? `${course.title} opens at launch` : "Pentesting opens at launch"}
          </Heading>
          <p id={reasonId} className="au-notice__body">
            {reason || PENTESTING_COMING_SOON_REASON}
          </p>
        </div>
      </div>
      <div className="au-actions">
        <button
          type="button"
          className="au-btn"
          aria-disabled="true"
          aria-describedby={reasonId}
          onClick={(event) => event.preventDefault()}
        >
          {action} (coming soon)
        </button>
        {courseId ? (
          <Link to={`/courses/${courseId}`} className="au-btn au-btn--secondary">
            Browse the course
            <ArrowRight />
          </Link>
        ) : null}
        <Link to="/tracks/pentesting" className="au-btn au-btn--secondary">
          See the Pentesting track
        </Link>
      </div>
    </div>
  );
}

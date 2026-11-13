import { useId } from "react";

import { Band, Button, Column, EmptyState, InlineNotification, Link, LoadingRegion, Skeleton, Tag } from "../../site-kit";
import { formatINR } from "../../utils/currency";
import { BandHeading, formatScheduleDays } from "./LandingParts";
import { LIVE_CLASSES_SUBTITLE, LIVE_CLASSES_TITLE } from "./landingContent";
import { isLiveClassOnAir } from "./useLandingData";

/** Price for a standalone class; an unpriced class is never called "Free" (plan §7.2 rule 7). */
export function formatLiveClassPrice(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return "On request";
  return formatINR(amount);
}

/**
 * The visitor's action for one class: the four previous states, each with a
 * plain-language reason line (plan §7.3 band 4).
 */
export function liveClassAction(liveClass) {
  const status = String(liveClass?.enrollment_status || "").toLowerCase();
  const courseId = Number(liveClass?.linked_course_id || 0);
  if (liveClass?.is_enrolled || status === "approved") {
    return {
      key: "open",
      label: "Open live class",
      href: courseId > 0 ? `/courses/${courseId}/live` : "/courses?view=owned",
      reason: "You are enrolled in this class.",
    };
  }
  if (status === "pending") {
    return { key: "pending", label: "Request pending", disabled: true, reason: "Your request is waiting for approval." };
  }
  if (courseId > 0) {
    return {
      key: "course",
      label: "View the course",
      href: `/courses/${courseId}`,
      reason: "This class is included with its course.",
    };
  }
  return { key: "closed", label: "Enrollment closed", disabled: true, reason: "This class is not taking new enrollments." };
}

function LiveClassCard({ liveClass, onAir }) {
  const reasonId = useId();
  const courseId = Number(liveClass.linked_course_id || 0);
  const action = liveClassAction(liveClass);
  return (
    <article className="lp-class" data-on-air={onAir ? "true" : undefined}>
      <div className="lp-class__tags">
        {onAir ? <Tag type="live" size="sm" /> : null}
        {/* The days are in the Schedule fact below; the tag only names the format. */}
        <Tag size="sm">Live class</Tag>
      </div>
      <h3 className="lp-class__title">{liveClass.title}</h3>
      <p className="lp-class__desc">{liveClass.description || "OSINT live class track with guided progression."}</p>
      <dl className="lp-class__facts">
        <div>
          <dt>Schedule</dt>
          <dd>{formatScheduleDays(liveClass.schedule_days)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{liveClass.class_duration_minutes ? `${liveClass.class_duration_minutes} min` : "1 hour"}</dd>
        </div>
        <div>
          <dt>{courseId ? "Access" : "Price"}</dt>
          <dd>{courseId ? "Included with course" : formatLiveClassPrice(liveClass.price)}</dd>
        </div>
      </dl>
      <p className="lp-class__meta">
        <span>{liveClass.enrollment_count ?? 0} enrolled</span>
        {courseId ? (
          <Link href={`/courses/${courseId}`} inline>
            Included with {liveClass.linked_course_title || "parent course"}
          </Link>
        ) : (
          <span>Standalone class</span>
        )}
      </p>
      <div className="lp-class__action">
        {action.disabled ? (
          <Button fullWidth disabled aria-describedby={reasonId}>
            {action.label}
          </Button>
        ) : (
          <Button fullWidth href={action.href} kind={action.key === "open" ? "primary" : "tertiary"} aria-describedby={reasonId}>
            {action.label}
          </Button>
        )}
        <p id={reasonId} className="lp-class__reason">
          {action.reason}
        </p>
      </div>
    </article>
  );
}

/**
 * Band 4: live classes. "Live" appears only while a class is on air. Empty:
 * one calm sentence and one real action. Error: Retry, keeping the last real
 * list with "Last updated". No fabricated classes, ever.
 */
export default function LiveClassesBand({ theme = "g10", liveClasses, liveBroadcast }) {
  const items = liveClasses.items;
  const failed = liveClasses.status === "error";
  const loading = liveClasses.status === "loading" && items.length === 0;

  let content = null;
  if (items.length) {
    content = (
      <ul className="lp-classes">
        {items.map((liveClass) => (
          <li key={liveClass.id}>
            <LiveClassCard liveClass={liveClass} onAir={isLiveClassOnAir(liveClass, liveBroadcast)} />
          </li>
        ))}
      </ul>
    );
  } else if (loading) {
    content = (
      <LoadingRegion label="Loading live classes" className="lp-classes">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} variant="block" decorative className="lp-class-skeleton" />
        ))}
      </LoadingRegion>
    );
  } else if (!failed) {
    content = (
      <EmptyState
        className="lp-empty"
        title="No live classes scheduled right now"
        action={{ label: "Browse courses", href: "/courses", kind: "primary" }}
      />
    );
  }

  return (
    <Band theme={theme} className="lp-band lp-live" labelledBy="lp-live-title">
      <Column sm={4} md={8} lg={10}>
        {/* The schedule subtitle describes classes; with none listed, the empty or error state speaks alone. */}
        <BandHeading id="lp-live-title" title={LIVE_CLASSES_TITLE} subtitle={items.length || loading ? LIVE_CLASSES_SUBTITLE : undefined} />
      </Column>
      <Column sm={4} md={8} lg={16} className="lp-live__content">
        {failed ? (
          <InlineNotification
            kind={items.length ? "warning" : "error"}
            lowContrast
            title={items.length ? "Showing the last live class list." : "Live classes could not be loaded."}
            subtitle={items.length ? "The live class feed did not respond." : "Check your connection and try again."}
            lastUpdated={items.length ? liveClasses.updatedAt : undefined}
            onRetry={liveClasses.retry}
            className="lp-notice"
          />
        ) : null}
        {content}
      </Column>
    </Band>
  );
}

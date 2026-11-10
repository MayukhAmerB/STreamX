import { ArrowRight, Calendar, CalendarAdd, Events, Exit, Ticket, Time, VideoChat } from "@carbon/icons-react";
import { Button, Tag, Tile } from "@carbon/react";
import { Link } from "react-router-dom";
import { siteBrand } from "../../config/siteBrand";
import { DEFAULT_LIVE_CLASS_SCHEDULE } from "../../utils/liveClassSchedule";
import LegacyPageFrame from "../app-shell/LegacyPageFrame";
import { useToast } from "../app-shell/ui";
import { downloadCalendarFile } from "./calendarDownload";
import { sessionStatusLabel, sessionTypeLabel } from "./liveSessions";
import { buildLiveScheduleIcs, formatNextClass, formatScheduleSummary } from "./schedule";

// Join handlers report their own errors on the page; never leave a
// rejected promise unhandled from a click.
function runJoin(onJoin, sessionId) {
  if (typeof onJoin !== "function") return;
  Promise.resolve()
    .then(() => onJoin(sessionId))
    .catch(() => {});
}

/** Pulsing red dot used with every "Live" label. */
export function LiveDot() {
  return <span className="lc-live-dot" aria-hidden="true" />;
}

function hostLine(session) {
  const host = String(session?.host?.full_name || "").trim();
  return [host ? `With ${host}` : "", session?.session_type ? sessionTypeLabel(session.session_type) : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The one thing to do when a class is on: a big "Join class" button. */
export function LiveNowCard({ session, onJoin, joining = false, note = "" }) {
  const title = session?.title || "Your live class";
  const meta = hostLine(session);
  return (
    <Tile className="lc-live-card">
      <div className="lc-live-card__body">
        <Tag type="red" size="md" className="lc-live-tag">
          <LiveDot />
          Live now
        </Tag>
        <h2 className="lc-live-card__title">{title}</h2>
        {meta ? <p className="lc-live-card__meta">{meta}</p> : null}
        {note ? <p className="lc-live-card__note">{note}</p> : null}
      </div>
      <Button
        size="lg"
        renderIcon={ArrowRight}
        className="lc-live-card__join"
        onClick={() => runJoin(onJoin, session?.id)}
        disabled={joining || !session?.id}
      >
        {joining ? "Joining…" : "Join class"}
      </Button>
    </Tile>
  );
}

/** Nothing live: when the next class is, the weekly times, add to calendar. */
export function NextClassCard({
  schedule,
  title = "No live class right now",
  hint = "This page updates on its own when your class starts.",
}) {
  const { showToast } = useToast();
  const currentSchedule = schedule || DEFAULT_LIVE_CLASS_SCHEDULE;

  const handleAddToCalendar = () => {
    const ics = buildLiveScheduleIcs(currentSchedule, {
      title: `${siteBrand.name} live class`,
      brand: siteBrand.name,
      url: typeof window !== "undefined" ? `${window.location.origin}/join-live` : "",
    });
    const added = downloadCalendarFile(ics, "live-classes.ics");
    showToast(
      added
        ? { kind: "success", title: "Calendar file ready", subtitle: "Open it to add the weekly classes." }
        : { kind: "error", title: "Couldn't create the calendar file." }
    );
  };

  return (
    <Tile className="lc-next-card">
      <div className="lc-next-card__body">
        <h2 className="lc-next-card__title">{title}</h2>
        <dl className="lc-next-card__facts">
          <div className="lc-next-card__fact">
            <dt>Next class</dt>
            <dd>{formatNextClass(currentSchedule)}</dd>
          </div>
          <div className="lc-next-card__fact">
            <dt>Every week</dt>
            <dd>{formatScheduleSummary(currentSchedule)}</dd>
          </div>
        </dl>
        {hint ? <p className="lc-next-card__hint">{hint}</p> : null}
      </div>
      <Button kind="tertiary" renderIcon={CalendarAdd} className="lc-next-card__action" onClick={handleAddToCalendar}>
        Add to calendar
      </Button>
    </Tile>
  );
}

/** One row per session: status, title, and Join when it can be joined. */
export function SessionTile({ session, joinable, highlighted = false, joining = false, onJoin, scheduleSummary }) {
  const status = String(session?.status || "").toLowerCase();
  const isLive = status === "live";
  const host = String(session?.host?.full_name || "").trim();
  return (
    <Tile className={`lc-session${highlighted ? " lc-session--highlighted" : ""}`}>
      <div className="lc-session__body">
        <div className="lc-tags">
          <Tag type={isLive ? "red" : "gray"} size="sm">
            {isLive ? <LiveDot /> : null}
            {sessionStatusLabel(status)}
          </Tag>
          <Tag type="cool-gray" size="sm">
            {sessionTypeLabel(session?.session_type)}
          </Tag>
          {highlighted ? (
            <Tag type="blue" size="sm">
              Shared link
            </Tag>
          ) : null}
        </div>
        <h3 className="lc-session__title">{session?.title || "Live session"}</h3>
        {session?.description ? <p className="lc-session__description">{session.description}</p> : null}
        {host ? <p className="lc-session__host">With {host}</p> : null}
      </div>
      <div className="lc-session__action">
        {joinable ? (
          <Button
            size="md"
            renderIcon={ArrowRight}
            className="lc-touch-btn"
            onClick={() => runJoin(onJoin, session.id)}
            disabled={joining}
            aria-label={joining ? `Joining ${session?.title || "session"}` : `Join ${session?.title || "session"}`}
          >
            {joining ? "Joining…" : "Join"}
          </Button>
        ) : (
          <p className="lc-session__when">
            <Time size={16} aria-hidden="true" />
            <span>
              <span className="lc-session__when-label">Not live yet</span>
              <span>{scheduleSummary}</span>
            </span>
          </p>
        )}
      </div>
    </Tile>
  );
}

/** Leave the class player (shown next to the class title). */
export function LeaveClassButton({ onLeave }) {
  return (
    <Button kind="secondary" size="md" renderIcon={Exit} className="lc-touch-btn" onClick={onLeave}>
      Leave
    </Button>
  );
}

/** Link to every live session (meetings and broadcasts) on /join-live. */
export function AllSessionsLink() {
  return (
    <Button as={Link} to="/join-live" kind="ghost" size="md" renderIcon={ArrowRight} className="lc-touch-btn">
      See all live sessions
    </Button>
  );
}

/** Opens the same class on the stand-alone live page (a second player). */
export function BackupPlayerLink({ href = "/join-live" }) {
  return (
    <Button as={Link} to={href || "/join-live"} kind="ghost" size="md" renderIcon={VideoChat} className="lc-touch-btn">
      Trouble playing? Open the backup player
    </Button>
  );
}

/**
 * The two-way meeting room still uses the website's dark styles; this keeps
 * them intact inside a Carbon page (Carbon's scoped reset skips legacy frames).
 */
export function LiveMeetingFrame({ children }) {
  return (
    <div className="lc-meeting">
      <LegacyPageFrame>{children}</LegacyPageFrame>
    </div>
  );
}

/**
 * One live-class track (e.g. "Month 1 - Beginner") with a single clear
 * action for the student's access state.
 */
export function LiveTrackTile({
  track,
  monthLabel,
  levelLabel,
  hasApprovedAccess,
  liveSession,
  joining = false,
  onJoin,
  scheduleSummary,
  nextClassLabel,
  priceLabel,
}) {
  const enrollmentStatus = String(track?.enrollment_status || "").toLowerCase();
  const linkedCourseId = track?.linked_course_id;
  const duration = track?.class_duration_minutes ? `${track.class_duration_minutes} min per class` : "1 hour per class";
  const enrolled = Number(track?.enrollment_count ?? 0) || 0;

  let action;
  if (hasApprovedAccess && liveSession) {
    action = (
      <Button
        renderIcon={ArrowRight}
        className="lc-track__primary"
        onClick={() => runJoin(onJoin, liveSession.id)}
        disabled={joining}
      >
        {joining ? "Joining…" : "Join class"}
      </Button>
    );
  } else if (hasApprovedAccess) {
    action = (
      <p className="lc-track__next">
        <Time size={16} aria-hidden="true" />
        <span>Next class: {nextClassLabel}</span>
      </p>
    );
  } else if (enrollmentStatus === "pending") {
    action = (
      <Button kind="secondary" className="lc-track__primary" disabled>
        Request pending
      </Button>
    );
  } else if (linkedCourseId) {
    action = (
      <Button as={Link} to={`/courses/${linkedCourseId}`} kind="tertiary" className="lc-track__primary" renderIcon={ArrowRight}>
        View course
      </Button>
    );
  } else {
    action = (
      <Button kind="secondary" className="lc-track__primary" disabled>
        Enrollment required
      </Button>
    );
  }

  return (
    <Tile className="lc-track">
      <div className="lc-tags">
        <Tag type="blue" size="sm">
          {monthLabel}
        </Tag>
        {hasApprovedAccess ? (
          <Tag type="green" size="sm">
            Access approved
          </Tag>
        ) : null}
        {!linkedCourseId ? (
          <Tag type="gray" size="sm">
            Preview
          </Tag>
        ) : null}
        {liveSession ? (
          <Tag type="red" size="sm">
            <LiveDot />
            Live now
          </Tag>
        ) : null}
      </div>
      {levelLabel ? <p className="lc-track__eyebrow">{levelLabel}</p> : null}
      <h3 className="lc-track__title">{track?.title || "Live class"}</h3>
      {track?.description ? <p className="lc-track__description">{track.description}</p> : null}
      <dl className="lc-track__facts">
        <div className="lc-track__fact">
          <dt>
            <Calendar size={16} aria-hidden="true" />
            <span className="lc-visually-hidden">Schedule</span>
          </dt>
          <dd>{scheduleSummary}</dd>
        </div>
        <div className="lc-track__fact">
          <dt>
            <Time size={16} aria-hidden="true" />
            <span className="lc-visually-hidden">Duration</span>
          </dt>
          <dd>{duration}</dd>
        </div>
        <div className="lc-track__fact">
          <dt>
            <Ticket size={16} aria-hidden="true" />
            <span className="lc-visually-hidden">{linkedCourseId ? "Access" : "Price"}</span>
          </dt>
          <dd>
            {linkedCourseId ? (
              <Link to={`/courses/${linkedCourseId}`} className="lc-track__link">
                Included with {track?.linked_course_title || "the course"}
              </Link>
            ) : (
              priceLabel
            )}
          </dd>
        </div>
        <div className="lc-track__fact">
          <dt>
            <Events size={16} aria-hidden="true" />
            <span className="lc-visually-hidden">Students</span>
          </dt>
          <dd>{enrolled} enrolled</dd>
        </div>
      </dl>
      <div className="lc-track__action">{action}</div>
    </Tile>
  );
}

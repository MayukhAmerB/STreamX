import {
  CheckmarkFilled,
  CheckmarkOutline,
  Login,
  SkipBack,
  SkipForward,
  ThumbsUp,
  ThumbsUpFilled,
} from "@carbon/icons-react";
import { Link } from "react-router-dom";
import { formatCount } from "./formatters";

function Chip({ icon: Icon, label, kind = "default", pressed, disabled, onClick, ariaLabel, shortcut, busy, className = "" }) {
  return (
    <button
      type="button"
      className={`cp-chip cp-chip--${kind}${pressed ? " is-pressed" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={pressed === undefined ? undefined : pressed ? "true" : "false"}
      aria-label={ariaLabel}
      aria-keyshortcuts={shortcut}
      aria-busy={busy ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {Icon ? <Icon size={20} aria-hidden="true" /> : null}
      <span className="cp-chip__label">{label}</span>
    </button>
  );
}

/**
 * The action row under the lesson title: Like (with count), Previous, Next,
 * Mark complete. Comments live once, in their tab (plan §3.4). On phones the
 * row becomes an icon toolbar (Like, Mark complete, Previous) above a full
 * width 48 px "Next lesson" button, so nothing scrolls sideways.
 */
export default function LessonActions({
  engagement,
  isAuthenticated,
  locked,
  loginState,
  previousLecture,
  nextLecture,
  onPrevious,
  onNext,
  completed,
  completing,
  onToggleComplete,
}) {
  const engagementReady = isAuthenticated && !locked && engagement?.summaryStatus === "ready";
  // Keep the Like chip in place (disabled) while counts load, so the row never jumps.
  const engagementLoading = isAuthenticated && !locked && engagement?.summaryStatus === "loading";
  // Signed out: the sign-in chip. Locked: no social actions at all.
  const hasSocial = !isAuthenticated || !locked;
  const likeCount = engagement?.likeCount || 0;

  return (
    <div className="cp-actions" role="group" aria-label="Lesson actions">
      {hasSocial ? (
        <div className="cp-actions__group cp-actions__group--social">
          {!isAuthenticated ? (
            <Link className="cp-chip cp-chip--default" to="/login" state={loginState}>
              <Login size={20} aria-hidden="true" />
              <span className="cp-chip__label">Sign in to like and comment</span>
            </Link>
          ) : null}
          {engagementLoading ? <Chip icon={ThumbsUp} label="Like" ariaLabel="Like this lesson" disabled /> : null}
          {engagementReady ? (
            <Chip
              icon={engagement.liked ? ThumbsUpFilled : ThumbsUp}
              label={likeCount > 0 ? formatCount(likeCount) : "Like"}
              ariaLabel={`Like this lesson, ${likeCount} ${likeCount === 1 ? "like" : "likes"}`}
              pressed={engagement.liked}
              onClick={() => void engagement.toggleLike()}
            />
          ) : null}
        </div>
      ) : null}
      <div className="cp-actions__group cp-actions__group--lesson">
        <Chip
          icon={SkipBack}
          label="Previous"
          ariaLabel={previousLecture ? `Previous lesson: ${previousLecture.title}` : "Previous lesson"}
          shortcut="Shift+P"
          className="cp-chip--icon-mobile cp-chip--previous"
          disabled={!previousLecture}
          onClick={onPrevious}
        />
        <Chip
          icon={SkipForward}
          label="Next lesson"
          kind="primary"
          ariaLabel={nextLecture ? `Next lesson: ${nextLecture.title}` : "Next lesson"}
          shortcut="Shift+N"
          className="cp-chip--next"
          disabled={!nextLecture}
          onClick={onNext}
        />
        {!locked && isAuthenticated ? (
          <Chip
            icon={completed ? CheckmarkFilled : CheckmarkOutline}
            label={completed ? "Completed" : "Mark complete"}
            kind={completed ? "success" : "default"}
            pressed={Boolean(completed)}
            className="cp-chip--icon-mobile cp-chip--complete"
            busy={completing}
            disabled={completing}
            onClick={onToggleComplete}
          />
        ) : null}
      </div>
    </div>
  );
}

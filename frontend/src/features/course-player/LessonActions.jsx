import {
  Chat,
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

function Chip({ icon: Icon, label, kind = "default", pressed, disabled, onClick, ariaLabel, shortcut, busy }) {
  return (
    <button
      type="button"
      className={`cp-chip cp-chip--${kind}${pressed ? " is-pressed" : ""}`}
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
 * The action row under the lesson title — the same icons and words as
 * YouTube / Udemy so nothing needs explaining: Like (with count), Comments
 * (with count), Previous, Next, Mark complete. On phones it is a single
 * horizontally scrollable row of chips.
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
  onOpenComments,
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
  const commentCount = engagement?.commentCount || 0;

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
          {isAuthenticated && !locked ? (
            <Chip
              icon={Chat}
              label={engagementReady && commentCount > 0 ? formatCount(commentCount) : "Comments"}
              ariaLabel={
                engagementReady ? `Comments, ${commentCount} ${commentCount === 1 ? "comment" : "comments"}` : "Comments"
              }
              onClick={onOpenComments}
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
          disabled={!previousLecture}
          onClick={onPrevious}
        />
        <Chip
          icon={SkipForward}
          label="Next"
          kind="primary"
          ariaLabel={nextLecture ? `Next lesson: ${nextLecture.title}` : "Next lesson"}
          shortcut="Shift+N"
          disabled={!nextLecture}
          onClick={onNext}
        />
        {!locked && isAuthenticated ? (
          <Chip
            icon={completed ? CheckmarkFilled : CheckmarkOutline}
            label={completed ? "Completed" : "Mark complete"}
            kind={completed ? "success" : "default"}
            pressed={Boolean(completed)}
            busy={completing}
            disabled={completing}
            onClick={onToggleComplete}
          />
        ) : null}
      </div>
    </div>
  );
}

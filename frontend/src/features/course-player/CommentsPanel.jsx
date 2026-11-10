import { Chat, Locked, Login } from "@carbon/icons-react";
import { Button, InlineLoading, SkeletonText } from "@carbon/react";
import { forwardRef } from "react";
import { Link } from "react-router-dom";
import PageNotification from "../app-shell/ui/PageNotification";
import CommentComposer from "./CommentComposer";
import CommentItem from "./CommentItem";
import { formatCount } from "./formatters";

/** Shown instead of like/comment controls to signed-out viewers. */
export function SignInPrompt({ loginState, compact = false }) {
  return (
    <div className={`cp-signin${compact ? " cp-signin--compact" : ""}`}>
      <Login size={20} aria-hidden="true" className="cp-signin__icon" />
      <p className="cp-signin__text">Sign in to like and comment.</p>
      <Button as={Link} to="/login" state={loginState} kind="primary" size="md">
        Sign in
      </Button>
    </div>
  );
}

function CommentsSkeleton() {
  return (
    <div className="cp-comments__skeleton" role="status" aria-busy="true">
      <span className="cds--visually-hidden">Loading comments</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="cp-comments__skeleton-row" aria-hidden="true">
          <span className="cp-avatar cp-avatar--md cp-avatar--skeleton" />
          <div className="cp-comments__skeleton-text">
            <SkeletonText width="30%" />
            <SkeletonText paragraph lineCount={2} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PanelMessage({ icon: Icon, title, text, action }) {
  return (
    <div className="cp-panel-message">
      {Icon ? <Icon size={24} aria-hidden="true" /> : null}
      <p className="cp-panel-message__title">{title}</p>
      {text ? <p className="cp-panel-message__text">{text}</p> : null}
      {action || null}
    </div>
  );
}

/**
 * Comments tab. Desktop shows the composer above the list; on phones the
 * composer is docked at the bottom of the screen instead (`docked`).
 */
const CommentsPanel = forwardRef(function CommentsPanel(
  { engagement, isAuthenticated, locked, enrollHref, loginState, author, docked = false, now },
  headingRef
) {
  const count = engagement?.summaryStatus === "ready" ? engagement.commentCount : null;

  let content;
  if (!isAuthenticated) {
    content = <SignInPrompt loginState={loginState} />;
  } else if (locked) {
    content = (
      <PanelMessage
        icon={Locked}
        title="Enroll to join the discussion"
        text="Comments open up once you have access to this lesson."
        action={
          enrollHref ? (
            <Button as={Link} to={enrollHref} kind="primary" size="md">
              Enroll now
            </Button>
          ) : null
        }
      />
    );
  } else if (engagement.summaryStatus === "forbidden") {
    content = <PanelMessage icon={Locked} title="Comments are available to enrolled learners." />;
  } else {
    const loading = engagement.commentsStatus === "loading" || engagement.commentsStatus === "idle";
    content = (
      <>
        {!docked ? <CommentComposer variant="inline" author={author} onSubmit={(body) => engagement.addComment(body, author)} /> : null}
        {loading ? <CommentsSkeleton /> : null}
        {engagement.commentsStatus === "error" ? (
          <PageNotification
            kind="error"
            title="Couldn't load comments."
            subtitle="Check your connection and try again."
            actionLabel="Try again"
            onAction={engagement.retry}
          />
        ) : null}
        {engagement.commentsStatus === "ready" && engagement.comments.length === 0 ? (
          <PanelMessage
            icon={Chat}
            title="No comments yet"
            text={docked ? "Be the first to comment. Write below." : "Be the first to comment."}
          />
        ) : null}
        {engagement.comments.length > 0 ? (
          <ul className="cp-comments__list" aria-label="Comments">
            {engagement.comments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                now={now}
                onEdit={engagement.editComment}
                onDelete={engagement.deleteComment}
              />
            ))}
          </ul>
        ) : null}
        {engagement.hasMore ? (
          <div className="cp-comments__more">
            {engagement.loadingMore ? (
              <InlineLoading description="Loading more comments…" />
            ) : (
              <Button kind="tertiary" size="md" onClick={() => void engagement.loadMore()}>
                Load more comments
              </Button>
            )}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className={`cp-comments${docked ? " cp-comments--docked" : ""}`}>
      <h2 ref={headingRef} id="cp-panel-heading-comments" className="cp-panel-title" tabIndex={-1}>
        Comments
        {count !== null ? (
          <>
            {" "}
            <span className="cp-panel-title__count">{formatCount(count)}</span>
          </>
        ) : null}
      </h2>
      {content}
    </div>
  );
});

export default CommentsPanel;

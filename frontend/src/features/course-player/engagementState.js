// Likes + comments state for one lecture, as a pure reducer. Every optimistic
// change has an explicit confirm and rollback action, so the UI updates
// instantly and returns to the server truth when a request fails.

export const COMMENT_MAX_LENGTH = 2000;
/** The character counter only appears once a comment gets this long. */
export const COMMENT_COUNTER_THRESHOLD = 1800;

export function createInitialEngagementState(lectureId = null) {
  return {
    lectureId,
    summaryStatus: "idle", // idle | loading | ready | error | forbidden | unauthenticated
    likeCount: 0,
    liked: false,
    commentCount: 0,
    commentsStatus: "idle", // idle | loading | ready | error
    comments: [],
    page: 0,
    hasMore: false,
    loadingMore: false,
  };
}

/** Maps the API's engagement summary onto state fields. */
export function summaryFields(summary) {
  return {
    likeCount: Math.max(0, Number(summary?.like_count) || 0),
    liked: Boolean(summary?.liked),
    commentCount: Math.max(0, Number(summary?.comment_count) || 0),
  };
}

function dedupeById(comments) {
  const seen = new Set();
  return comments.filter((comment) => {
    const key = String(comment.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function engagementReducer(state, action) {
  switch (action.type) {
    case "reset":
      return {
        ...createInitialEngagementState(action.lectureId ?? null),
        summaryStatus: action.lectureId ? "loading" : "idle",
        commentsStatus: action.lectureId ? "loading" : "idle",
      };

    case "summaryLoaded":
      return { ...state, ...summaryFields(action.summary), summaryStatus: "ready" };

    case "summaryFailed":
      return { ...state, summaryStatus: action.status || "error" };

    case "likeOptimistic": {
      const liked = Boolean(action.liked);
      if (liked === state.liked) return state;
      return { ...state, liked, likeCount: Math.max(0, state.likeCount + (liked ? 1 : -1)) };
    }

    case "likeSettled":
      // Server truth for likes; the comment count is kept as tracked locally.
      return {
        ...state,
        likeCount: Math.max(0, Number(action.summary?.like_count) || 0),
        liked: Boolean(action.summary?.liked),
      };

    case "likeRollback":
      return { ...state, liked: Boolean(action.liked), likeCount: Math.max(0, Number(action.likeCount) || 0) };

    case "commentsLoading":
      return action.append ? { ...state, loadingMore: true } : { ...state, commentsStatus: "loading" };

    case "commentsLoaded": {
      const results = Array.isArray(action.results) ? action.results : [];
      const pagination = action.pagination || {};
      const comments = action.append ? dedupeById([...state.comments, ...results]) : results;
      return {
        ...state,
        comments,
        commentsStatus: "ready",
        loadingMore: false,
        page: Number(pagination.page) || (action.append ? state.page + 1 : 1),
        hasMore: Boolean(pagination.has_next),
        commentCount:
          !action.append && Number.isFinite(Number(pagination.total)) && state.summaryStatus !== "ready"
            ? Number(pagination.total)
            : state.commentCount,
      };
    }

    case "commentsFailed":
      return action.append
        ? { ...state, loadingMore: false }
        : { ...state, commentsStatus: "error", loadingMore: false };

    case "commentAddOptimistic":
      return {
        ...state,
        comments: [action.comment, ...state.comments],
        commentCount: state.commentCount + 1,
      };

    case "commentAddConfirmed":
      return {
        ...state,
        comments: state.comments.map((comment) =>
          String(comment.id) === String(action.tempId) ? action.comment : comment
        ),
      };

    case "commentAddRollback":
      return {
        ...state,
        comments: state.comments.filter((comment) => String(comment.id) !== String(action.tempId)),
        commentCount: Math.max(0, state.commentCount - 1),
      };

    case "commentUpdateOptimistic":
      return {
        ...state,
        comments: state.comments.map((comment) =>
          String(comment.id) === String(action.id)
            ? { ...comment, body: action.body, is_edited: true, pending: true }
            : comment
        ),
      };

    case "commentUpdateConfirmed":
    case "commentUpdateRollback":
      return {
        ...state,
        comments: state.comments.map((comment) =>
          String(comment.id) === String(action.comment.id) ? action.comment : comment
        ),
      };

    case "commentRemoveOptimistic":
      return {
        ...state,
        comments: state.comments.filter((comment) => String(comment.id) !== String(action.id)),
        commentCount: Math.max(0, state.commentCount - 1),
      };

    case "commentRemoveRollback": {
      if (state.comments.some((comment) => String(comment.id) === String(action.comment.id))) return state;
      const comments = [...state.comments];
      const index = Math.max(0, Math.min(Number(action.index) || 0, comments.length));
      comments.splice(index, 0, action.comment);
      return { ...state, comments, commentCount: state.commentCount + 1 };
    }

    default:
      return state;
  }
}

/** Client-side validation mirroring the API (non-empty, <= 2000 chars). */
export function validateCommentBody(body) {
  const trimmed = String(body || "").trim();
  if (!trimmed) return { ok: false, body: trimmed, error: "Write something first." };
  if (trimmed.length > COMMENT_MAX_LENGTH) {
    return { ok: false, body: trimmed, error: `Keep it under ${COMMENT_MAX_LENGTH} characters.` };
  }
  return { ok: true, body: trimmed, error: "" };
}

/** Counter text near the limit ("1,850 / 2,000"), else "". */
export function commentCounterText(body, max = COMMENT_MAX_LENGTH, threshold = COMMENT_COUNTER_THRESHOLD) {
  const length = String(body || "").length;
  if (length < threshold) return "";
  return `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`;
}

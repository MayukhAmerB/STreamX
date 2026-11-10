// Engagement (likes + comments) controller for one lecture at a time.
// Framework-free: React subscribes through useLectureEngagement, tests drive
// it directly with a mocked API.
import { apiData, apiMessage } from "../../utils/api";
import {
  createInitialEngagementState,
  engagementReducer,
  validateCommentBody,
} from "./engagementState";

export const COMMENTS_PAGE_SIZE = 20;

function statusOf(error) {
  return Number(error?.response?.status) || 0;
}

/** Toast copy for a failed write. 429 gets the familiar "slow down" message. */
export function describeEngagementError(error, fallbackTitle) {
  const status = statusOf(error);
  if (status === 429) {
    return { kind: "warning", title: "You're going a bit fast", subtitle: "Wait a few seconds, then try again." };
  }
  if (status === 401) {
    return { kind: "error", title: "Your session has ended", subtitle: "Sign in again to continue." };
  }
  if (status === 403) {
    return { kind: "error", title: fallbackTitle, subtitle: "You don't have access to this lesson's discussion." };
  }
  if (!error?.response) {
    return { kind: "error", title: fallbackTitle, subtitle: "Check your connection and try again." };
  }
  return { kind: "error", title: fallbackTitle, subtitle: apiMessage(error, "Please try again.") };
}

/**
 * @param {object} options
 * @param {object} options.api  { getSummary, setLike, listComments, createComment, updateComment, deleteComment }
 * @param {(toast: {kind: string, title: string, subtitle?: string}) => void} [options.notify]
 */
export function createEngagementStore({ api, notify = () => {}, pageSize = COMMENTS_PAGE_SIZE, now = () => Date.now() }) {
  let state = createInitialEngagementState();
  const listeners = new Set();
  let loadToken = 0;
  let likeRequestSeq = 0;
  let confirmedLike = { liked: false, likeCount: 0 };
  let tempSeq = 0;

  function dispatch(action) {
    const next = engagementReducer(state, action);
    if (next === state) return;
    state = next;
    listeners.forEach((listener) => listener());
  }

  const isCurrent = (token, lectureId) => token === loadToken && state.lectureId === lectureId;

  async function loadComments(lectureId, token, { append = false } = {}) {
    const page = append ? state.page + 1 : 1;
    dispatch({ type: "commentsLoading", append });
    try {
      const response = await api.listComments(lectureId, { page, pageSize });
      if (!isCurrent(token, lectureId)) return;
      const data = apiData(response) || {};
      dispatch({ type: "commentsLoaded", results: data.results, pagination: data.pagination, append });
    } catch (error) {
      if (!isCurrent(token, lectureId)) return;
      dispatch({ type: "commentsFailed", append });
      if (append) notify(describeEngagementError(error, "Couldn't load more comments"));
    }
  }

  async function loadSummary(lectureId, token) {
    try {
      const response = await api.getSummary(lectureId);
      if (!isCurrent(token, lectureId)) return;
      const summary = apiData(response) || {};
      confirmedLike = { liked: Boolean(summary.liked), likeCount: Math.max(0, Number(summary.like_count) || 0) };
      dispatch({ type: "summaryLoaded", summary });
    } catch (error) {
      if (!isCurrent(token, lectureId)) return;
      const status = statusOf(error);
      dispatch({
        type: "summaryFailed",
        status: status === 403 ? "forbidden" : status === 401 ? "unauthenticated" : "error",
      });
    }
  }

  const store = {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Starts (or restarts) loading engagement for a lecture; null clears it. */
    load(lectureId) {
      loadToken += 1;
      likeRequestSeq += 1;
      const token = loadToken;
      confirmedLike = { liked: false, likeCount: 0 };
      dispatch({ type: "reset", lectureId: lectureId ?? null });
      if (!lectureId) return Promise.resolve();
      return Promise.all([loadSummary(lectureId, token), loadComments(lectureId, token)]);
    },

    retry() {
      return store.load(state.lectureId);
    },

    loadMore() {
      if (!state.lectureId || !state.hasMore || state.loadingMore) return Promise.resolve();
      return loadComments(state.lectureId, loadToken, { append: true });
    },

    /** Optimistic like toggle; the newest request decides, failures roll back. */
    async toggleLike() {
      const lectureId = state.lectureId;
      if (!lectureId || state.summaryStatus !== "ready") return;
      const token = loadToken;
      const desired = !state.liked;
      const seq = ++likeRequestSeq;
      dispatch({ type: "likeOptimistic", liked: desired });
      try {
        const response = await api.setLike(lectureId, desired);
        if (!isCurrent(token, lectureId)) return;
        const summary = apiData(response) || {};
        confirmedLike = { liked: Boolean(summary.liked), likeCount: Math.max(0, Number(summary.like_count) || 0) };
        if (seq === likeRequestSeq) dispatch({ type: "likeSettled", summary });
      } catch (error) {
        if (!isCurrent(token, lectureId) || seq !== likeRequestSeq) return;
        dispatch({ type: "likeRollback", ...confirmedLike });
        notify(describeEngagementError(error, desired ? "Couldn't like this lesson" : "Couldn't remove your like"));
      }
    },

    /** Posts a comment instantly; resolves false (and restores nothing) on failure. */
    async addComment(body, author = {}) {
      const lectureId = state.lectureId;
      const validation = validateCommentBody(body);
      if (!lectureId || !validation.ok) return false;
      const token = loadToken;
      const tempId = `temp-${++tempSeq}`;
      const timestamp = new Date(now()).toISOString();
      dispatch({
        type: "commentAddOptimistic",
        comment: {
          id: tempId,
          lecture_id: lectureId,
          body: validation.body,
          author: {
            id: author.id ?? null,
            display_name: author.display_name || "You",
            is_instructor: Boolean(author.is_instructor),
          },
          is_mine: true,
          is_edited: false,
          can_delete: true,
          created_at: timestamp,
          updated_at: timestamp,
          pending: true,
        },
      });
      try {
        const response = await api.createComment(lectureId, validation.body);
        if (!isCurrent(token, lectureId)) return true;
        const created = apiData(response);
        if (created) dispatch({ type: "commentAddConfirmed", tempId, comment: created });
        else dispatch({ type: "commentAddRollback", tempId });
        return Boolean(created);
      } catch (error) {
        if (isCurrent(token, lectureId)) dispatch({ type: "commentAddRollback", tempId });
        notify(describeEngagementError(error, "Couldn't post your comment"));
        return false;
      }
    },

    async editComment(commentId, body) {
      const lectureId = state.lectureId;
      const original = state.comments.find((comment) => String(comment.id) === String(commentId));
      const validation = validateCommentBody(body);
      if (!lectureId || !original || !validation.ok) return false;
      if (validation.body === original.body) return true;
      const token = loadToken;
      dispatch({ type: "commentUpdateOptimistic", id: commentId, body: validation.body });
      try {
        const response = await api.updateComment(commentId, validation.body);
        if (!isCurrent(token, lectureId)) return true;
        const updated = apiData(response);
        dispatch({ type: "commentUpdateConfirmed", comment: updated || { ...original, body: validation.body, is_edited: true } });
        return true;
      } catch (error) {
        if (isCurrent(token, lectureId)) dispatch({ type: "commentUpdateRollback", comment: original });
        notify(describeEngagementError(error, "Couldn't save your edit"));
        return false;
      }
    },

    async deleteComment(commentId) {
      const lectureId = state.lectureId;
      const index = state.comments.findIndex((comment) => String(comment.id) === String(commentId));
      if (!lectureId || index < 0) return false;
      const original = state.comments[index];
      const token = loadToken;
      dispatch({ type: "commentRemoveOptimistic", id: commentId });
      try {
        await api.deleteComment(commentId);
        return true;
      } catch (error) {
        // Already gone on the server: keep it removed.
        if (statusOf(error) === 404) return true;
        if (isCurrent(token, lectureId)) dispatch({ type: "commentRemoveRollback", comment: original, index });
        notify(describeEngagementError(error, "Couldn't delete the comment"));
        return false;
      }
    },
  };

  return store;
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createLectureComment,
  deleteLectureComment,
  getLectureEngagement,
  listLectureComments,
  setLectureLike,
  updateLectureComment,
} from "../../api/lectureEngagement";
import { useToast } from "../app-shell/ui/toast";
import { createEngagementStore } from "./engagementStore";

export const defaultEngagementApi = {
  getSummary: getLectureEngagement,
  setLike: setLectureLike,
  listComments: listLectureComments,
  createComment: createLectureComment,
  updateComment: updateLectureComment,
  deleteComment: deleteLectureComment,
};

/**
 * Likes and comments for the current lecture with optimistic updates.
 * `enabled` is false for signed-out viewers and locked lessons (the API
 * would answer 401/403), so nothing is requested for them.
 */
export function useLectureEngagement(lectureId, { enabled = true, api = defaultEngagementApi } = {}) {
  const { showToast } = useToast();
  const notifyRef = useRef(showToast);
  notifyRef.current = showToast;

  const [store] = useState(() =>
    createEngagementStore({ api, notify: (toast) => notifyRef.current?.(toast) })
  );
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const activeLectureId = enabled && lectureId ? lectureId : null;

  useEffect(() => {
    void store.load(activeLectureId);
  }, [store, activeLectureId]);

  return useMemo(
    () => ({
      ...state,
      enabled: Boolean(activeLectureId),
      toggleLike: store.toggleLike,
      addComment: store.addComment,
      editComment: store.editComment,
      deleteComment: store.deleteComment,
      loadMore: store.loadMore,
      retry: store.retry,
    }),
    [state, store, activeLectureId]
  );
}

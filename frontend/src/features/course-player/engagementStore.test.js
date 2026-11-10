import { describe, expect, it, vi } from "vitest";
import {
  commentCounterText,
  createInitialEngagementState,
  engagementReducer,
  validateCommentBody,
} from "./engagementState";
import { createEngagementStore, describeEngagementError } from "./engagementStore";
import { createMockEngagementApi, deferred, envelope, makeComment } from "./testFixtures";

describe("engagementReducer", () => {
  const ready = engagementReducer(createInitialEngagementState(5), {
    type: "summaryLoaded",
    summary: { like_count: 3, liked: false, comment_count: 2 },
  });

  it("applies and rolls back an optimistic like", () => {
    const liked = engagementReducer(ready, { type: "likeOptimistic", liked: true });
    expect(liked).toMatchObject({ liked: true, likeCount: 4 });
    expect(engagementReducer(liked, { type: "likeOptimistic", liked: true })).toBe(liked);
    expect(engagementReducer(liked, { type: "likeRollback", liked: false, likeCount: 3 })).toMatchObject({
      liked: false,
      likeCount: 3,
    });
  });

  it("never counts below zero", () => {
    const state = { ...ready, likeCount: 0, liked: true };
    expect(engagementReducer(state, { type: "likeOptimistic", liked: false }).likeCount).toBe(0);
  });

  it("adds, confirms and rolls back comments with the count", () => {
    const temp = makeComment({ id: "temp-1", pending: true });
    const added = engagementReducer(ready, { type: "commentAddOptimistic", comment: temp });
    expect(added.comments[0].id).toBe("temp-1");
    expect(added.commentCount).toBe(3);
    const confirmed = engagementReducer(added, { type: "commentAddConfirmed", tempId: "temp-1", comment: makeComment({ id: 9 }) });
    expect(confirmed.comments.map((comment) => comment.id)).toEqual([9]);
    const rolledBack = engagementReducer(added, { type: "commentAddRollback", tempId: "temp-1" });
    expect(rolledBack.comments).toEqual([]);
    expect(rolledBack.commentCount).toBe(2);
  });

  it("restores a deleted comment at its original position", () => {
    const list = { ...ready, comments: [makeComment({ id: 1 }), makeComment({ id: 2 }), makeComment({ id: 3 })] };
    const removed = engagementReducer(list, { type: "commentRemoveOptimistic", id: 2 });
    expect(removed.comments.map((comment) => comment.id)).toEqual([1, 3]);
    const restored = engagementReducer(removed, { type: "commentRemoveRollback", comment: list.comments[1], index: 1 });
    expect(restored.comments.map((comment) => comment.id)).toEqual([1, 2, 3]);
    expect(restored.commentCount).toBe(list.commentCount);
  });

  it("appends pages without duplicates", () => {
    const first = engagementReducer(ready, {
      type: "commentsLoaded",
      results: [makeComment({ id: 1 }), makeComment({ id: 2 })],
      pagination: { page: 1, has_next: true, total: 3 },
    });
    const second = engagementReducer(first, {
      type: "commentsLoaded",
      append: true,
      results: [makeComment({ id: 2 }), makeComment({ id: 3 })],
      pagination: { page: 2, has_next: false },
    });
    expect(second.comments.map((comment) => comment.id)).toEqual([1, 2, 3]);
    expect(second).toMatchObject({ page: 2, hasMore: false });
  });
});

describe("comment validation", () => {
  it("rejects empty and over-long comments", () => {
    expect(validateCommentBody("   ").ok).toBe(false);
    expect(validateCommentBody("x".repeat(2001)).ok).toBe(false);
    expect(validateCommentBody("  Great lesson  ")).toEqual({ ok: true, body: "Great lesson", error: "" });
  });

  it("shows the counter only near the limit", () => {
    expect(commentCounterText("x".repeat(100))).toBe("");
    expect(commentCounterText("x".repeat(1850))).toBe("1,850 / 2,000");
  });
});

describe("describeEngagementError", () => {
  it("uses friendly copy for rate limits and offline errors", () => {
    expect(describeEngagementError({ response: { status: 429 } }, "x")).toMatchObject({ kind: "warning" });
    expect(describeEngagementError(new Error("Network Error"), "Couldn't post")).toMatchObject({
      title: "Couldn't post",
      subtitle: "Check your connection and try again.",
    });
    expect(
      describeEngagementError({ response: { status: 400, data: { errors: { body: ["Not allowed."] } } } }, "Couldn't post")
    ).toMatchObject({ subtitle: "Not allowed." });
  });
});

describe("createEngagementStore", () => {
  async function loadedStore(apiOverrides = {}) {
    const api = createMockEngagementApi(apiOverrides);
    const notify = vi.fn();
    const store = createEngagementStore({ api, notify, now: () => Date.parse("2026-11-10T12:00:00Z") });
    await store.load(7);
    return { api, notify, store };
  }

  it("loads the summary and the first page of comments", async () => {
    const { api, store } = await loadedStore();
    expect(api.getSummary).toHaveBeenCalledWith(7);
    expect(api.listComments).toHaveBeenCalledWith(7, { page: 1, pageSize: 20 });
    expect(store.getState()).toMatchObject({
      lectureId: 7,
      summaryStatus: "ready",
      likeCount: 4,
      liked: false,
      commentCount: 2,
      commentsStatus: "ready",
      hasMore: true,
    });
  });

  it("likes optimistically and keeps the server result", async () => {
    const request = deferred();
    const { api, store } = await loadedStore({ setLike: vi.fn(() => request.promise) });
    const pending = store.toggleLike();
    expect(store.getState()).toMatchObject({ liked: true, likeCount: 5 });
    expect(api.setLike).toHaveBeenCalledWith(7, true);
    request.resolve(envelope({ lecture_id: 7, like_count: 9, liked: true, comment_count: 2 }));
    await pending;
    expect(store.getState()).toMatchObject({ liked: true, likeCount: 9 });
  });

  it("rolls the like back and shows a toast when the request fails", async () => {
    const { store, notify } = await loadedStore({
      setLike: vi.fn().mockRejectedValue({ response: { status: 429 } }),
    });
    await store.toggleLike();
    expect(store.getState()).toMatchObject({ liked: false, likeCount: 4 });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "warning", title: "You're going a bit fast" }));
  });

  it("lets only the newest of rapid like toggles decide", async () => {
    const first = deferred();
    const second = deferred();
    const setLike = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { store } = await loadedStore({ setLike });
    const a = store.toggleLike();
    const b = store.toggleLike();
    expect(store.getState()).toMatchObject({ liked: false, likeCount: 4 });
    second.resolve(envelope({ like_count: 4, liked: false }));
    first.resolve(envelope({ like_count: 5, liked: true }));
    await Promise.all([a, b]);
    expect(store.getState()).toMatchObject({ liked: false, likeCount: 4 });
  });

  it("posts a comment instantly, then swaps in the saved one", async () => {
    const request = deferred();
    const { store, api } = await loadedStore({ createComment: vi.fn(() => request.promise) });
    const posting = store.addComment("  Loved it  ", { id: 3, display_name: "Asha Rao" });
    const optimistic = store.getState().comments[0];
    expect(optimistic).toMatchObject({ body: "Loved it", pending: true, is_mine: true, author: { display_name: "Asha Rao" } });
    expect(store.getState().commentCount).toBe(3);
    expect(api.createComment).toHaveBeenCalledWith(7, "Loved it");
    request.resolve(envelope(makeComment({ id: 50, body: "Loved it" })));
    expect(await posting).toBe(true);
    expect(store.getState().comments[0]).toMatchObject({ id: 50, body: "Loved it" });
    expect(store.getState().comments[0].pending).toBeUndefined();
  });

  it("removes a failed comment and reports it", async () => {
    const { store, notify } = await loadedStore({
      createComment: vi.fn().mockRejectedValue({ response: { status: 400, data: { errors: { body: ["Links are not allowed."] } } } }),
    });
    expect(await store.addComment("spam", {})).toBe(false);
    expect(store.getState().comments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(store.getState().commentCount).toBe(2);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't post your comment", subtitle: "Links are not allowed." }));
  });

  it("ignores empty comments without calling the API", async () => {
    const { store, api } = await loadedStore();
    expect(await store.addComment("   ", {})).toBe(false);
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("edits optimistically and rolls back on failure", async () => {
    const { store, api } = await loadedStore({
      updateComment: vi.fn().mockRejectedValueOnce({ response: { status: 500 } }),
    });
    const editing = store.editComment(1, "Changed");
    expect(store.getState().comments[0]).toMatchObject({ body: "Changed", is_edited: true });
    expect(await editing).toBe(false);
    expect(store.getState().comments[0]).toMatchObject({ body: "First comment", is_edited: false });
    expect(api.updateComment).toHaveBeenCalledWith(1, "Changed");
  });

  it("deletes optimistically and restores the comment on failure", async () => {
    const { store, notify } = await loadedStore({
      deleteComment: vi.fn().mockRejectedValueOnce({ response: { status: 403 } }),
    });
    const deleting = store.deleteComment(2);
    expect(store.getState().comments.map((comment) => comment.id)).toEqual([1]);
    expect(store.getState().commentCount).toBe(1);
    expect(await deleting).toBe(false);
    expect(store.getState().comments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(store.getState().commentCount).toBe(2);
    expect(notify).toHaveBeenCalled();
  });

  it("treats a 404 on delete as already deleted", async () => {
    const { store } = await loadedStore({ deleteComment: vi.fn().mockRejectedValue({ response: { status: 404 } }) });
    expect(await store.deleteComment(1)).toBe(true);
    expect(store.getState().comments.map((comment) => comment.id)).toEqual([2]);
  });

  it("loads more comments", async () => {
    const { store, api } = await loadedStore();
    await store.loadMore();
    expect(api.listComments).toHaveBeenLastCalledWith(7, { page: 2, pageSize: 20 });
    expect(store.getState().comments.map((comment) => comment.id)).toEqual([1, 2, 3]);
    expect(store.getState().hasMore).toBe(false);
  });

  it("drops late responses from a previous lecture", async () => {
    const slow = deferred();
    const api = createMockEngagementApi();
    api.getSummary.mockImplementationOnce(() => slow.promise);
    const store = createEngagementStore({ api });
    const first = store.load(7);
    await store.load(8);
    slow.resolve(envelope({ like_count: 99, liked: true, comment_count: 0 }));
    await first;
    expect(store.getState()).toMatchObject({ lectureId: 8, likeCount: 4 });
  });

  it("marks forbidden lectures so the UI can hide the controls", async () => {
    const api = createMockEngagementApi({ getSummary: vi.fn().mockRejectedValue({ response: { status: 403 } }) });
    const store = createEngagementStore({ api });
    await store.load(7);
    expect(store.getState().summaryStatus).toBe("forbidden");
  });
});

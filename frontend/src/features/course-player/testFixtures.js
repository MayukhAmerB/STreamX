// Shared fixtures for the course player tests (not imported by app code).
import { vi } from "vitest";

export function makeCourse(overrides = {}) {
  return {
    id: 29,
    title: "OSINT Professional",
    description: "Course description",
    is_enrolled: true,
    sections: [
      {
        id: 1,
        title: "Foundations",
        description: "Module one description",
        lectures: [
          {
            id: 11,
            title: "Welcome",
            stream_duration_seconds: 300,
            is_preview: true,
            progress: { completed: true, percent_complete: 100, updated_at: "2026-11-01T10:00:00Z" },
          },
          {
            id: 12,
            title: "Search operators",
            stream_duration_seconds: 900,
            progress: {
              completed: false,
              percent_complete: 40,
              resume_position_seconds: 360,
              updated_at: "2026-11-05T10:00:00Z",
            },
          },
        ],
      },
      {
        id: 2,
        title: "Recon",
        description: "",
        lectures: [
          { id: 21, title: "Maps", stream_duration_seconds: 600, description: "Lesson text" },
          { id: 22, title: "Images", stream_duration_seconds: 1200 },
        ],
      },
    ],
    ...overrides,
  };
}

/** Axios-like response with the API envelope. */
export function envelope(data) {
  return { data: { success: true, message: "", data, errors: null } };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function makeComment(overrides = {}) {
  return {
    id: 1,
    lecture_id: 7,
    body: "First comment",
    author: { id: 3, display_name: "Asha Rao", is_instructor: false },
    is_mine: true,
    is_edited: false,
    can_delete: true,
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
    ...overrides,
  };
}

export const FIXTURE_COMMENTS = [
  makeComment(),
  makeComment({
    id: 2,
    body: "Second comment",
    author: { id: 9, display_name: "Imran Syed", is_instructor: true },
    is_mine: false,
    can_delete: false,
  }),
  makeComment({ id: 3, body: "Third comment", is_mine: false, can_delete: false, author: { id: 4, display_name: "Ravi K", is_instructor: false } }),
];

/** Engagement API double: 4 likes, 2 comments on page 1, one more on page 2. */
export function createMockEngagementApi(overrides = {}, fn = (impl) => vi.fn(impl)) {
  return {
    getSummary: fn(async (lectureId) => envelope({ lecture_id: lectureId, like_count: 4, liked: false, comment_count: 2 })),
    setLike: fn(async (lectureId, liked) =>
      envelope({ lecture_id: lectureId, like_count: liked ? 5 : 4, liked, comment_count: 2 })
    ),
    listComments: fn(async (_lectureId, { page = 1 } = {}) =>
      envelope(
        page === 1
          ? { results: FIXTURE_COMMENTS.slice(0, 2), pagination: { page: 1, page_size: 20, total: 3, pages: 2, has_next: true, has_previous: false } }
          : { results: FIXTURE_COMMENTS.slice(2), pagination: { page: 2, page_size: 20, total: 3, pages: 2, has_next: false, has_previous: true } }
      )
    ),
    createComment: fn(async (_lectureId, body) => envelope(makeComment({ id: 100, body }))),
    updateComment: fn(async (commentId, body) => envelope(makeComment({ id: commentId, body, is_edited: true }))),
    deleteComment: fn(async () => envelope(null)),
    ...overrides,
  };
}

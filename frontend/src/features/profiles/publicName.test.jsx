// Owner privacy rule (handle only): student-facing UI renders another student by
// their HANDLE, never a real name or e-mail, even if a payload carried one.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import CourseReviews from "../../components/CourseReviews";
import CommentItem from "../course-player/CommentItem";
import { Board } from "../engagement-ui/LeaderboardPage";
import { isStaffLike, liveJoinDisplayName, publicName } from "./publicName";

vi.mock("../../hooks/useAuth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: 99, role: "student", full_name: "Viewer Person" } }),
}));

const REAL = { full_name: "Zenobia Quartermaine", email: "zenobia.quartermaine@privacy-scan.test" };
const html = (node) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

function expectNoRealIdentity(markup) {
  expect(markup).not.toContain("Zenobia");
  expect(markup).not.toContain("Quartermaine");
  expect(markup).not.toContain("privacy-scan.test");
}

describe("publicName", () => {
  it("prefers the handle, then the server display name, and never reads real-name fields", () => {
    expect(publicName({ ...REAL, handle: "quiet_cipher", display_name: "other" })).toBe("quiet_cipher");
    expect(publicName({ ...REAL, display_name: "operative_k3q7xa" })).toBe("operative_k3q7xa");
    expect(publicName({ ...REAL })).toBe("Learner");
    expect(publicName(null, "You")).toBe("You");
    expect(publicName("steady_lantern")).toBe("steady_lantern");
  });

  it("students join live classes without sending their name; staff may send theirs", () => {
    expect(liveJoinDisplayName({ role: "student", ...REAL })).toBe("");
    expect(liveJoinDisplayName(null)).toBe("");
    expect(liveJoinDisplayName({ role: "instructor", full_name: "Teaching Person" })).toBe("Teaching Person");
    expect(liveJoinDisplayName({ role: "student", is_staff: true, full_name: "Admin Person" })).toBe("Admin Person");
    expect(isStaffLike({ role: "student" })).toBe(false);
  });
});

describe("handle-only rendering", () => {
  it("leaderboard rows show the handle", () => {
    const data = {
      batch: { id: 1, title: "OSINT Foundations", batch: "Batch 7" },
      participants: 2,
      entries: [
        { rank: 1, handle: "quiet_cipher", display_name: "quiet_cipher", ...REAL, xp: 300, level: { number: 2, title: "Operative" }, is_me: false },
        { rank: 2, handle: "steady_lantern", display_name: "steady_lantern", xp: 40, level: { number: 1, title: "Recruit" }, is_me: true },
      ],
      me: { rank: 2, xp: 40, visible: true, handle: "steady_lantern", display_name: "steady_lantern" },
    };
    const markup = html(<Board data={data} period="week" />);
    expect(markup).toContain("quiet_cipher");
    expect(markup).toContain("steady_lantern");
    expectNoRealIdentity(markup);
  });

  it("lecture comments show the author's handle", () => {
    const comment = {
      id: 5,
      body: "Sharp pivot here.",
      author: { id: 7, display_name: "operative_k3q7xa", ...REAL, is_instructor: false },
      is_mine: false,
      can_delete: false,
      created_at: "2026-11-10T11:55:00Z",
    };
    const markup = html(<ul><CommentItem comment={comment} now={Date.parse("2026-11-10T12:00:00Z")} /></ul>);
    expect(markup).toContain("operative_k3q7xa");
    expectNoRealIdentity(markup);
  });

  it("course reviews label the reviewer by handle", () => {
    const experience = {
      reviews: [{ rating: 5, author: "steady_lantern", text: "Clear and practical.", date: "2026-09-23T12:00:00Z" }],
      has_more: false,
      can_review: false,
      own_review: null,
    };
    const markup = html(<CourseReviews courseId={1} experience={experience} refresh={() => {}} />);
    expect(markup).toContain("steady_lantern");
    expect(markup).toContain("Handle");
    expect(markup).not.toContain("Roll number");
  });
});

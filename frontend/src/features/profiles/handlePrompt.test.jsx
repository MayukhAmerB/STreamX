// Owner privacy rule (handle only): the one-time "choose your handle" prompt
// and the leaderboard display setting (handle | hidden; no real names).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

import { AuthContext } from "../../context/AuthContext";
import { DISPLAY_CHOICES, normalizeDisplay } from "../engagement-ui/engagementModel";
import HandlePrompt, { handleProblem, shouldPromptForHandle } from "./HandlePrompt";

describe("handle prompt", () => {
  it("opens only for an automatic handle the student has not answered", () => {
    expect(shouldPromptForHandle({ handle: "operative_k3q7xa", handle_auto: true, handle_prompt: true })).toBe(true);
    expect(shouldPromptForHandle({ handle: "operative_k3q7xa", handle_auto: true, handle_prompt: false })).toBe(false);
    expect(shouldPromptForHandle({ handle: "quiet_cipher", handle_auto: false, handle_prompt: false })).toBe(false);
    expect(shouldPromptForHandle(null)).toBe(false);
  });

  it("mirrors the server's handle rule", () => {
    expect(handleProblem("")).toMatch(/Type a handle/);
    expect(handleProblem("Quiet Cipher")).toMatch(/lower-case/);
    expect(handleProblem("a__b")).toMatch(/lower-case/);
    expect(handleProblem("operative_abc123")).toMatch(/automatic/);
    expect(handleProblem("@quiet_cipher")).toBe("");
  });

  it("renders nothing before the profile answered (and never for staff)", () => {
    const render = (user) =>
      renderToStaticMarkup(
        <AuthContext.Provider value={{ user }}>
          <HandlePrompt />
        </AuthContext.Provider>
      );
    expect(render({ id: 1, role: "student" })).toBe("");
    expect(render({ id: 2, role: "student", is_admin: true })).toBe("");
  });
});

describe("leaderboard display setting", () => {
  it("offers handle or hidden only and maps retired values to handle", () => {
    expect(Object.keys(DISPLAY_CHOICES)).toEqual(["handle", "hidden"]);
    expect(normalizeDisplay("initials")).toBe("handle");
    expect(normalizeDisplay("name")).toBe("handle");
    expect(normalizeDisplay("hidden")).toBe("hidden");
    expect(normalizeDisplay(undefined)).toBe("handle");
  });
});

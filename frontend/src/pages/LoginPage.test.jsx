import { describe, expect, it } from "vitest";

import { homeAfterLogin, LEARNER_HOME, STAFF_HOME } from "./LoginPage";

describe("LoginPage: where a sign-in lands (plan D3)", () => {
  it("sends staff to Admin and everyone else to the Console", () => {
    expect(STAFF_HOME).toBe("/console/admin");
    expect(LEARNER_HOME).toBe("/console");
    expect(homeAfterLogin({ is_admin: true, role: "admin" })).toBe("/console/admin");
    expect(homeAfterLogin({ is_admin: false, role: "instructor" })).toBe("/console");
    expect(homeAfterLogin({ role: "student" })).toBe("/console");
    expect(homeAfterLogin(null)).toBe("/console");
  });
});

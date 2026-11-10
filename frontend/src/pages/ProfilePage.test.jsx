import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { formatMemberSince, getAccountRoleLabel, ProfileView } from "./ProfilePage";

const noop = () => {};

function render(props = {}) {
  return renderToStaticMarkup(
    <StaticRouter location="/profile">
      <ProfileView
        user={{ full_name: "Asha Rao", email: "asha@example.com", role: "student", created_at: "2025-02-01T00:00:00Z" }}
        name="Asha Rao"
        phone="+91 98765 43210"
        previewUrl=""
        saving={false}
        error=""
        dirty={false}
        onNameChange={noop}
        onPhoneChange={noop}
        onPhotoSelect={noop}
        onSubmit={noop}
        {...props}
      />
    </StaticRouter>
  );
}

describe("ProfilePage", () => {
  it("labels roles", () => {
    expect(getAccountRoleLabel({ is_admin: true })).toBe("Administrator");
    expect(getAccountRoleLabel({ role: "instructor" })).toBe("Instructor");
    expect(getAccountRoleLabel(null)).toBe("Student");
    expect(formatMemberSince("not a date")).toBe("");
  });

  it("renders labelled Carbon fields and a disabled Save until something changes", () => {
    const html = render();
    expect(html).toContain('for="profile-name"');
    expect(html).toContain('for="profile-phone"');
    expect(html).toContain('type="tel"');
    expect(html).toContain("Change photo");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain("Student");
    expect(html).toContain('href="/id-card"');
  });

  it("enables Save when dirty and shows errors inline", () => {
    const html = render({ dirty: true, error: "Phone is invalid." });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    expect(html).toContain("Phone is invalid.");
  });
});

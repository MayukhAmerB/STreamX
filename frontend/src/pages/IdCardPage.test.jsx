import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { siteBrand } from "../config/siteBrand";
import { AuthContext } from "../context/AuthContext";
import IdCardPage from "./IdCardPage";

function renderIdCard(user) {
  return renderToStaticMarkup(
    <AuthContext.Provider value={{ user, isAuthenticated: true }}>
      <StaticRouter location="/id-card">
        <IdCardPage />
      </StaticRouter>
    </AuthContext.Provider>
  );
}

const student = {
  id: 42,
  full_name: "Asha Rao",
  email: "asha.rao@example.com",
  phone_number: "+91 98765 43210",
  role: "student",
  created_at: "2025-02-11T09:00:00Z",
  profile_image_url: "",
};

describe("IdCardPage", () => {
  it("renders the branded credential with the signed-in user's details", () => {
    const html = renderIdCard(student);
    expect(html).toContain("asi-id-card-shell");
    expect(html).toContain("id-card-protected-root");
    expect(html).toContain("AL-SYD-00042");
    expect(html).toContain("LV3");
    expect(html).toContain("Asha Rao");
    expect(html).toContain("@asha.rao");
    expect(html).toContain("asha.rao@example.com");
    expect(html).toContain("+91 98765 43210");
    expect(html).toContain("Not Verified");
    expect(html).toContain(`${siteBrand.name} Member`);
    // Watermark lines and the print-only warning are still present.
    expect(html).toContain("PRIVATE CREDENTIAL");
    expect(html).toContain("Printing and static export of this protected credential are disabled.");
  });

  it("puts the page chrome in Carbon: header actions, sharing warning and panels", () => {
    const html = renderIdCard(student);
    expect(html).toContain('class="cds-page-header"');
    expect(html).toMatch(/<a[^>]*href="\/profile"[^>]*>.*Edit profile/);
    expect(html).toMatch(/<a[^>]*href="\/my-courses"[^>]*>.*My courses/);
    expect(html).toContain("Do not share this card.");
    expect(html).toContain("Account");
    expect(html).toContain("Your access");
    expect(html).toContain("How your card is protected");
    // No download / share / print actions on a protected credential.
    expect(html).not.toMatch(/>(Download|Share|Print)</);
  });

  it("derives role and clearance for staff accounts", () => {
    const admin = renderIdCard({ ...student, is_admin: true });
    expect(admin).toContain("Administrator");
    expect(admin).toContain("LV5");
    const instructor = renderIdCard({ ...student, role: "instructor" });
    expect(instructor).toContain("Instructor");
    expect(instructor).toContain("LV4");
  });
});

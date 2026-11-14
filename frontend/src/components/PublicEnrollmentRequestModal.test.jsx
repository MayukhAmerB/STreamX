import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";
import PublicEnrollmentRequestModal from "./PublicEnrollmentRequestModal";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ turnstileEnabled: false, turnstileSiteKey: "" }),
}));

vi.mock("../api/courses", () => ({
  submitPublicEnrollmentLead: vi.fn(() => Promise.resolve({ data: { message: "ok" } })),
}));

function markup(props = {}) {
  return renderToStaticMarkup(
    <StaticRouter location="/">
      <PublicEnrollmentRequestModal isOpen onClose={() => {}} targetType="general" {...props} />
    </StaticRouter>
  );
}

describe("PublicEnrollmentRequestModal", () => {
  it("is a modal dialog named by its heading", () => {
    const html = markup();
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toMatch(new RegExp(`id="${labelledBy.replace(/[^\w-]/g, "\\$&")}"[^>]*>Enrollment Enquiry<`));
  });

  it("renders nothing while closed", () => {
    expect(markup({ isOpen: false })).toBe("");
  });
});

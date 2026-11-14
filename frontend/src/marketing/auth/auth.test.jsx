import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AuthContext } from "../../context/AuthContext";
import { AuthField, AuthMessage, AuthSubmit } from "./AuthControls";
import AuthSplit, { AuthArt } from "./AuthSplit";
import { AUTH_CHROMELESS_PATHS, isAuthChromelessPath } from "./chromeless";
import ComingSoonPanel from "./ComingSoonPanel";
import { PENTESTING_COMING_SOON_REASON, isPentestingCourse, pentestingPurchaseGate } from "./pentestingGate";
import ResetPasswordPage, { readResetLink, validateNewPassword } from "./ResetPasswordPage";

const pentest = { id: 42, title: "Command Line Fluency", category: "web_pentesting" };
const osint = { id: 7, title: "OSINT cohort", category: "osint" };
const switchedOff = {
  response: {
    status: 403,
    data: { code: "feature_disabled", detail: "Pentesting opens at launch.", errors: { feature: "pentesting", code: "feature_disabled" } },
  },
};

function html(node, path = "/") {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

describe("pentestingPurchaseGate", () => {
  it("never blocks a course outside the Pentesting track", () => {
    expect(isPentestingCourse(osint)).toBe(false);
    expect(pentestingPurchaseGate(osint, { error: switchedOff }).blocked).toBe(false);
    expect(pentestingPurchaseGate(null).blocked).toBe(false);
  });

  it("is open when nothing says the switch is off", () => {
    expect(pentestingPurchaseGate(pentest)).toEqual({ blocked: false, reason: "", code: "" });
    expect(pentestingPurchaseGate(pentest, { caps: { items: { "pentesting-purchase": { state: "enabled" } } } }).blocked).toBe(false);
    expect(pentestingPurchaseGate(pentest, { gates: { pentesting: { enabled: true } } }).blocked).toBe(false);
  });

  it("blocks with the server reason after a 403 feature_disabled", () => {
    const gate = pentestingPurchaseGate(pentest, { error: switchedOff });
    expect(gate).toEqual({ blocked: true, reason: "Pentesting opens at launch.", code: "feature_disabled" });
  });

  it("ignores a 403 for a different switch and any other error", () => {
    const other = { response: { status: 403, data: { code: "feature_disabled", detail: "x", errors: { feature: "memberships" } } } };
    expect(pentestingPurchaseGate(pentest, { error: other }).blocked).toBe(false);
    expect(pentestingPurchaseGate(pentest, { error: { response: { status: 400, data: {} } } }).blocked).toBe(false);
  });

  it("reads the course purchase_gate, the catalogue gates and the capabilities", () => {
    expect(
      pentestingPurchaseGate({ ...pentest, purchase_gate: { state: "coming_soon", code: "feature_disabled", reason: "Soon." } })
    ).toMatchObject({ blocked: true, reason: "Soon." });
    expect(pentestingPurchaseGate({ ...pentest, purchase_gate: { state: "unavailable", code: "registration_closed", reason: "Closed" } }).blocked).toBe(false);
    expect(pentestingPurchaseGate(pentest, { gates: { pentesting: { enabled: false, reason: "Gate." } } }).reason).toBe("Gate.");
    expect(pentestingPurchaseGate(pentest, { caps: { items: { "pentesting-purchase": { state: "disabled", reason: "Caps." } } } }).reason).toBe("Caps.");
    expect(pentestingPurchaseGate(pentest, { caps: { features: { pentesting: { enabled: false } } } })).toMatchObject({
      blocked: true,
      reason: PENTESTING_COMING_SOON_REASON,
    });
  });
});

describe("ComingSoonPanel", () => {
  it("shows the action disabled (not hidden) with the reason and a way to browse", () => {
    const markup = html(<ComingSoonPanel course={pentest} action="Apply" reason="Opens at launch." titleId="t" />);
    expect(markup).toContain('data-testid="pentesting-coming-soon"');
    expect(markup).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="t-reason"[^>]*>Apply \(coming soon\)<\/button>/);
    expect(markup).toContain('id="t-reason"');
    expect(markup).toContain("Opens at launch.");
    expect(markup).toContain("Command Line Fluency opens at launch");
    expect(markup).toContain('href="/courses/42"');
    expect(markup).toContain('href="/tracks/pentesting"');
    expect(markup).not.toMatch(/<button[^>]*type="submit"/);
  });
});

describe("AuthControls", () => {
  it("renders a visible label tied to the input, with hint and error described", () => {
    const markup = renderToStaticMarkup(<AuthField id="em" label="Email" type="email" hint="Work or personal" error="Required" required />);
    expect(markup).toContain('<label class="au-label" for="em">Email');
    expect(markup).toContain('aria-describedby="em-hint em-error"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('type="email"');
  });

  it("keeps the label text exactly the field name (journeys use getByLabel('Password', { exact: true }))", () => {
    const markup = renderToStaticMarkup(<AuthField id="pw" label="Password" reveal required />);
    expect(markup).toContain('<label class="au-label" for="pw">Password</label>');
    expect(markup).toContain('<span class="au-label__req" aria-hidden="true">*</span>');
  });

  it("gives the password reveal toggle an accessible name", () => {
    const markup = renderToStaticMarkup(<AuthField id="pw" label="Password" reveal />);
    expect(markup).toContain('type="password"');
    expect(markup).toContain('aria-label="Show password"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-controls="pw"');
  });

  it("keeps a disabled submit focusable and explains why", () => {
    const markup = renderToStaticMarkup(<AuthSubmit disabled disabledReason="Complete the security check first.">Login</AuthSubmit>);
    expect(markup).toMatch(/<button type="button"[^>]*aria-disabled="true"/);
    expect(markup).not.toContain("disabled=\"\"");
    expect(markup).toContain("Complete the security check first.");
    const busy = renderToStaticMarkup(<AuthSubmit loading>Login</AuthSubmit>);
    expect(busy).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(<AuthSubmit>Login</AuthSubmit>)).toContain('type="submit"');
  });

  it("announces errors assertively and other messages politely", () => {
    expect(renderToStaticMarkup(<AuthMessage tone="error">Wrong password</AuthMessage>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<AuthMessage tone="info">Sent</AuthMessage>)).toContain('role="status"');
  });
});

describe("AuthSplit", () => {
  it("is a labelled region with decorative (aria-hidden) line art and our credit", () => {
    const markup = html(
      <AuthSplit labelledBy="x-title">
        <h1 id="x-title">Sign in</h1>
      </AuthSplit>
    );
    expect(markup).toContain('aria-labelledby="x-title"');
    expect(markup.match(/au-art__line[^"]*" aria-hidden="true"/g)).toHaveLength(4);
    expect(markup).toContain('class="au-art__hub" aria-hidden="true"');
    expect(markup).toMatch(/Built and taught by/);
    expect(html(<AuthArt credit="" />)).not.toContain("au-art__credit");
  });
});

describe("chromeless auth paths", () => {
  it("covers sign-in and password reset only", () => {
    expect(AUTH_CHROMELESS_PATHS).toEqual(["/login", "/reset-password"]);
    expect(isAuthChromelessPath("/login")).toBe(true);
    expect(isAuthChromelessPath("/login/")).toBe(true);
    expect(isAuthChromelessPath("/reset-password")).toBe(true);
    expect(isAuthChromelessPath("/courses")).toBe(false);
    expect(isAuthChromelessPath("")).toBe(false);
  });
});

describe("ResetPasswordPage", () => {
  it("reads the uid/token pair from the e-mailed link", () => {
    expect(readResetLink("?uid=MQ&token=abc-123")).toEqual({ uid: "MQ", token: "abc-123" });
    expect(readResetLink("?uid=MQ")).toBeNull();
    expect(readResetLink("")).toBeNull();
  });

  it("checks length and match before calling the server", () => {
    expect(validateNewPassword("short", "short")).toEqual({ field: "password", message: "Use at least 8 characters." });
    expect(validateNewPassword("long-enough", "different")).toMatchObject({ field: "confirm" });
    expect(validateNewPassword("long-enough", "long-enough")).toBeNull();
  });

  it("renders the form for a complete link and a calm dead end otherwise", () => {
    const withLink = html(
      <AuthContext.Provider value={{}}>
        <ResetPasswordPage />
      </AuthContext.Provider>,
      "/reset-password?uid=MQ&token=abc"
    );
    expect(withLink).toContain("Choose a new password");
    expect(withLink).toContain('autoComplete="new-password"');
    expect(withLink).toContain("Set new password");
    const broken = html(<ResetPasswordPage />, "/reset-password");
    expect(broken).toContain("Reset link incomplete");
    expect(broken).toContain('href="/login"');
    expect(broken).not.toContain("<form");
  });
});

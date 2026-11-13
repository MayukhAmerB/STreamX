import { describe, expect, it } from "vitest";
import { resolveReturnTarget, returnTargetFromSearch } from "./safeReturnUrl";

const prod = { hostname: "alsyedinitiative.com" };
const www = { hostname: "www.alsyedinitiative.com" };
const local = { hostname: "localhost" };

describe("resolveReturnTarget", () => {
  it("accepts in-app paths", () => {
    expect(resolveReturnTarget("/console", prod)).toEqual({ type: "internal", path: "/console" });
  });

  it("accepts the labs subdomain over https", () => {
    expect(resolveReturnTarget("https://labs.alsyedinitiative.com/#exam", prod)).toEqual({
      type: "external",
      href: "https://labs.alsyedinitiative.com/#exam",
    });
    expect(resolveReturnTarget("https://labs.alsyedinitiative.com/", www)?.type).toBe("external");
  });

  it("accepts the local labs dev server only from localhost", () => {
    expect(resolveReturnTarget("http://localhost:8092/#exam", local)?.type).toBe("external");
    expect(resolveReturnTarget("http://localhost:8092/#exam", prod)).toBeNull();
  });

  it.each([
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "https://labs.alsyedinitiative.com.evil.com/",
    "https://evil-labs.alsyedinitiative.com/",
    "http://labs.alsyedinitiative.com/",
    "https://labs.alsyedinitiative.com:8443/",
    "https://user:pw@labs.alsyedinitiative.com/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "",
    null,
  ])("rejects %s", (value) => {
    expect(resolveReturnTarget(value, prod)).toBeNull();
  });
});

describe("returnTargetFromSearch", () => {
  it("reads ?next=", () => {
    const search = `?next=${encodeURIComponent("https://labs.alsyedinitiative.com/#exam")}`;
    expect(returnTargetFromSearch(search, prod)?.href).toBe("https://labs.alsyedinitiative.com/#exam");
  });

  it("returns null without next", () => {
    expect(returnTargetFromSearch("", prod)).toBeNull();
  });
});

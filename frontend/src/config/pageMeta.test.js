import { describe, expect, it } from "vitest";

import { resolvePageMeta } from "./pageMeta";

describe("page meta", () => {
  it("gives the home page the brand title and description", () => {
    const meta = resolvePageMeta("/");
    expect(meta.title).toBe("Al syed Initiative | Cybersecurity Training");
    expect(meta.description).toMatch(/OSINT/);
    expect(meta).toMatchObject({ noindex: false, notFound: false, canonicalPath: "/" });
  });

  it("titles each public page and drops query strings and trailing slashes from canonicals", () => {
    expect(resolvePageMeta("/courses?category=osint")).toMatchObject({ title: "Courses | Al syed Initiative", canonicalPath: "/courses" });
    expect(resolvePageMeta("/courses/28/")).toMatchObject({ title: "Course details | Al syed Initiative", canonicalPath: "/courses/28" });
    expect(resolvePageMeta("/watch").title).toBe("Watch | Al syed Initiative");
    expect(resolvePageMeta("/national-desk").title).toBe("National Desk | Al syed Initiative");
  });

  it("keeps payment steps and unknown addresses out of search results", () => {
    expect(resolvePageMeta("/courses/28/payment")).toMatchObject({ noindex: true });
    expect(resolvePageMeta("/nope")).toMatchObject({ title: "Page not found | Al syed Initiative", noindex: true, notFound: true, canonicalPath: null });
  });
});

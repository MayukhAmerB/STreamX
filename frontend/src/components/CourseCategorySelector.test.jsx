import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import CourseCategorySelector from "./CourseCategorySelector";

describe("CourseCategorySelector", () => {
  it("renders the two professional tracks with their supplied artwork and course totals", () => {
    const html = renderToStaticMarkup(
      <CourseCategorySelector
        selectedCategory="osint"
        counts={{ osint: 4, web_pentesting: 3 }}
      />
    );

    expect(html).toContain("Choose your training path");
    expect(html).toContain("OSINT");
    expect(html).toContain("Pentesting");
    expect(html).toContain("Open Source Intelligence");
    expect(html).toContain("Web Application &amp; API Security");
    expect(html).toContain("4 courses");
    expect(html).toContain("3 courses");
    expect(html).toContain("course-track-osint.png");
    expect(html).toContain("course-track-pentesting.png");
    expect(html).toContain('aria-pressed="true"');
  });
});

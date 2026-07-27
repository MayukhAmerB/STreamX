import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import OsintToolsAccessCard from "./OsintToolsAccessCard";

describe("OsintToolsAccessCard", () => {
  it("links approved OSINT students to the finder and full library", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/courses">
        <OsintToolsAccessCard />
      </StaticRouter>
    );

    expect(html).toContain("OSINT Tools Library");
    expect(html).toContain('href="/osint-tools#beginner-tool-finder"');
    expect(html).toContain('href="/osint-tools"');
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import AppFooter from "./AppFooter";
import IndiaOnlyNote, { INDIA_ONLY_DETAIL } from "./IndiaOnlyNote";

vi.mock("../features/youtube/youTubeStore", () => ({
  useYouTubeChannel: () => ({ status: "idle", model: null, enabled: false }),
}));

describe("IndiaOnlyNote", () => {
  it("pill shows the label", () => {
    expect(renderToStaticMarkup(<IndiaOnlyNote />)).toContain("Only for Indians");
  });

  it("note shows the label and the explanation", () => {
    const html = renderToStaticMarkup(<IndiaOnlyNote variant="note" />);
    expect(html).toContain('role="note"');
    expect(html).toContain("Only for Indians.");
    expect(html).toContain(INDIA_ONLY_DETAIL);
  });

  it("is in the footer contact section", () => {
    const html = renderToStaticMarkup(<StaticRouter location="/"><AppFooter /></StaticRouter>);
    const contact = html.slice(html.indexOf('id="contact"'));
    expect(contact).toContain("Only for Indians");
  });
});

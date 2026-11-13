import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import AppFooter, { getFooterExploreLinks } from "./AppFooter";

const youtubeState = vi.hoisted(() => ({ current: { status: "ready", model: { live: null }, enabled: true } }));
vi.mock("../features/youtube/youTubeStore", () => ({ useYouTubeChannel: () => youtubeState.current }));

const render = (path = "/about") =>
  renderToStaticMarkup(
    <StaticRouter location={path}>
      <AppFooter />
    </StaticRouter>
  );

describe("AppFooter (Syed Carbon)", () => {
  afterEach(() => {
    youtubeState.current = { status: "ready", model: { live: null }, enabled: true };
  });

  it("is a g100 band that keeps #contact and adds Labs, National Desk, AS-Accounts and Join Al Syed", () => {
    const html = render();
    expect(html).toMatch(/^<footer id="contact" data-theme="g100" class="sf">/);
    for (const href of ["/", "/courses", "/watch", "/console", "/hall-of-fame", "/national-desk", "/as-accounts", "/join-alsyed", "/about", "/contact", "/faqs", "/terms"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('href="https://labs.alsyedinitiative.com" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("Secure Learning Infrastructure");
  });

  it("follows the landing page's last band directly (no top gap) only on /", () => {
    expect(render("/")).toMatch(/class="sf sf--flush"/);
    expect(render("/about")).not.toContain("sf--flush");
  });

  it("applies the header's Watch rule: hidden when off, disabled with a reason when empty", () => {
    expect(getFooterExploreLinks("alsyed", "hidden").map((link) => link.label)).not.toContain("Watch");
    expect(getFooterExploreLinks("owlcognito", "ready").map((link) => link.label)).toEqual(["Home", "Courses", "Watch", "Console"]);
    youtubeState.current = { status: "ready", model: null, enabled: true };
    const html = render();
    expect(html).not.toContain('href="/watch"');
    expect(html).toMatch(/role="link" aria-disabled="true" tabindex="0" aria-describedby="[^"]+">Watch<span id="[^"]+" class="sf__reason">No videos yet<\/span>/);
  });
});

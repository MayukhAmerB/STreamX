import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { fire, renderTree } from "../test-utils/renderTree";
import Tag, { TAG_VOCABULARY } from "./Tag";
import { ClickableTile, COMING_SOON_REASON, Tile } from "./Tile";

const html = (element) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

describe("site kit Tile / ClickableTile", () => {
  it("renders a static tile, with the accent rule only when featured", () => {
    expect(html(<Tile>Body</Tile>)).toBe('<div class="sk-tile">Body</div>');
    expect(html(<Tile featured as="article">Body</Tile>)).toBe('<article class="sk-tile sk-tile--featured">Body</article>');
  });

  it("is a single link with an arrow when open", () => {
    const markup = html(
      <ClickableTile href="/courses?category=osint#course-category-results" aria-label="View OSINT courses">
        OSINT
      </ClickableTile>
    );
    expect(markup).toMatch(/^<a [^>]*class="sk-tile sk-tile--clickable"/);
    expect(markup).toContain('href="/courses?category=osint#course-category-results"');
    expect(markup).toContain('aria-label="View OSINT courses"');
    expect(markup).toContain('<span class="sk-tile__arrow">');
    expect(markup.match(/<a /g)).toHaveLength(1);
  });

  it("opens external tiles in a new tab", () => {
    const markup = html(<ClickableTile href="https://labs.alsyedinitiative.com">Labs</ClickableTile>);
    expect(markup).toContain('target="_blank" rel="noopener noreferrer"');
    expect(markup).toContain("(opens in a new tab)");
  });

  it("coming soon: no href, aria-disabled, focusable, a visible reason it is described by, the tag, no arrow", () => {
    const markup = html(
      <ClickableTile href="/courses?category=web_pentesting" comingSoon aria-label="View Pentesting courses">
        Pentesting
      </ClickableTile>
    );
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("sk-tile__arrow");
    expect(markup).toMatch(/^<div role="link" aria-disabled="true" tabindex="0" class="sk-tile sk-tile--clickable is-disabled"/);
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)[1];
    expect(markup).toContain(`<p id="${describedBy}" class="sk-tile__reason">${COMING_SOON_REASON}</p>`);
    expect(markup).toContain(">Coming soon</span>");
    expect(COMING_SOON_REASON).toBe("Coming soon · No courses yet");
  });

  it("treats a tile without a target (count 0) as disabled with a reason", () => {
    const markup = html(<ClickableTile disabledReason="Lessons coming soon">Course</ClickableTile>);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain(">Lessons coming soon</p>");
    expect(html(<ClickableTile disabled href="/x">Course</ClickableTile>)).toContain(">Not available yet</p>");
  });

  it("does nothing when a disabled tile is activated, but leaves Tab alone", async () => {
    const onClick = vi.fn();
    const tree = await renderTree(
      <MemoryRouter>
        <ClickableTile comingSoon onClick={onClick}>
          Pentesting
        </ClickableTile>
      </MemoryRouter>
    );
    const tile = tree.find((node) => node.props.role === "link");
    const enter = vi.fn();
    const tab = vi.fn();
    await fire(tile, "onKeyDown", { key: "Enter", type: "keydown", preventDefault: enter });
    await fire(tile, "onKeyDown", { key: "Tab", type: "keydown", preventDefault: tab });
    await fire(tile, "onClick", { type: "click" });
    expect(enter).toHaveBeenCalledTimes(1);
    expect(tab).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    await tree.unmount();
  });
});

describe("site kit Tag (status vocabulary)", () => {
  it("uses one word per meaning with fixed colours", () => {
    expect(Object.fromEntries(Object.entries(TAG_VOCABULARY).map(([key, value]) => [key, [value.label, value.color]]))).toEqual({
      live: ["Live", "red"],
      open: ["Open", "green"],
      "coming-soon": ["Coming soon", "blue"],
      "previous-batch": ["Previous batch", "gray"],
      countdown: ["Countdown", "cool-gray"],
      neutral: ["", "gray"],
    });
  });

  it("gives only Live the pulsing dot and never paints the countdown red", () => {
    expect(html(<Tag type="live" />)).toBe(
      '<span class="sk-tag sk-tag--red sk-tag--md sk-tag--pill" data-status="live"><span class="sk-tag__live-dot" aria-hidden="true"></span><span class="sk-tag__label">Live</span></span>'
    );
    expect(html(<Tag type="open" />)).not.toContain("live-dot");
    expect(html(<Tag type="countdown">2 days left</Tag>)).toContain("sk-tag--cool-gray");
    expect(html(<Tag type="countdown">2 days left</Tag>)).not.toContain("red");
  });

  it("accepts a custom label, the small size and square corners", () => {
    expect(html(<Tag size="sm" pill={false}>OSINT</Tag>)).toBe(
      '<span class="sk-tag sk-tag--gray sk-tag--sm" data-status="neutral"><span class="sk-tag__label">OSINT</span></span>'
    );
    expect(html(<Tag type="unknown" />)).toContain('data-status="unknown"');
  });
});

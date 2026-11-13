import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { fire, renderTree } from "../test-utils/renderTree";
import Carousel from "./Carousel";

const cards = (count) => Array.from({ length: count }, (_unused, index) => <article key={index}>Course {index + 1}</article>);

describe("site kit Carousel", () => {
  it("is a focusable, labelled carousel region of numbered slides", () => {
    const markup = renderToStaticMarkup(
      <Carousel label="Bestsellers" previousLabel="Scroll courses backward" nextLabel="Scroll courses forward">
        {cards(3)}
      </Carousel>
    );
    expect(markup).toMatch(/role="region" aria-roledescription="carousel" aria-label="Bestsellers" tabindex="0"/);
    expect(markup).toContain('role="group" aria-roledescription="slide" aria-label="1 of 3"');
    expect(markup).toContain('aria-label="3 of 3"');
    // Previous is visible but aria-disabled at the start; nothing is removed.
    expect(markup).toMatch(/aria-label="Scroll courses backward" aria-controls="[^"]+" aria-disabled="true"/);
    expect(markup).toContain('aria-label="Scroll courses forward"');
    expect(markup).not.toMatch(/\sdisabled=""/);
  });

  it("sets slides per view through CSS variables", () => {
    expect(renderToStaticMarkup(<Carousel label="x" perView={{ sm: 1, md: 3, lg: 6 }}>{cards(2)}</Carousel>)).toContain(
      "--sk-per-view-sm:1;--sk-per-view-md:3;--sk-per-view-lg:6"
    );
  });

  it("has no controls for one slide and renders nothing for zero", () => {
    expect(renderToStaticMarkup(<Carousel label="x">{cards(1)}</Carousel>)).not.toContain("sk-carousel__control");
    expect(renderToStaticMarkup(<Carousel label="x">{[]}</Carousel>)).toBe("");
  });

  it("pages with the arrow keys and the buttons, but ignores keys pressed inside a slide", async () => {
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: true }) });
    const tree = await renderTree(
      <Carousel label="Bestsellers" previousLabel="Back" nextLabel="Forward">
        {cards(6)}
      </Carousel>
    );
    const track = tree.find((node) => node.props.role === "region");
    track.scrollBy = vi.fn();
    track.scrollTo = vi.fn();
    track.clientWidth = 900;
    track.scrollWidth = 5400;
    track.scrollLeft = 0;
    await fire(track, "onScroll"); // measure the ends again with real sizes
    const press = (key, target = track) => fire(track, "onKeyDown", { key, target, currentTarget: track });

    await press("ArrowRight");
    await press("ArrowLeft");
    await press("End");
    await press("Home");
    await press("ArrowRight", { type: "a" });
    expect(track.scrollBy.mock.calls).toEqual([[{ left: 900, behavior: "auto" }], [{ left: -900, behavior: "auto" }]]);
    expect(track.scrollTo).toHaveBeenCalledTimes(2);

    await fire(tree.getByLabel("button", "Forward"), "onClick");
    expect(track.scrollBy).toHaveBeenCalledTimes(3);
    // At the start, "Back" is aria-disabled and does nothing.
    await fire(tree.getByLabel("button", "Back"), "onClick");
    expect(track.scrollBy).toHaveBeenCalledTimes(3);
    await tree.unmount();
    vi.unstubAllGlobals();
  });
});

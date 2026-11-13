import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { act, fire, renderTree, textOf } from "../../test-utils/renderTree";
import LiteYouTubeEmbed from "./LiteYouTubeEmbed";
import YouTubeSection from "./YouTubeSection";
import YouTubeShowcase from "./YouTubeShowcase";
import { createYouTubeStore } from "./youTubeStore";
import { livePayload, payload } from "./youtubeFixtures";
import { normalizeYouTubePayload } from "./youtubeModel";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const iframes = (tree) => tree.all((node) => node.type === "iframe");

describe("LiteYouTubeEmbed", () => {
  it("shows only a thumbnail and a labelled play button until clicked", async () => {
    const tree = await renderTree(<LiteYouTubeEmbed videoId="dBL5_4EQ47M" title="OSINT class" />);
    expect(iframes(tree)).toHaveLength(0);
    const button = tree.getByLabel("button", "Play video: OSINT class");
    const poster = tree.find((node) => node.type === "img");
    expect(poster.props.src).toBe("https://i.ytimg.com/vi/dBL5_4EQ47M/maxresdefault.jpg");
    expect(poster.props.alt).toBe("");

    await fire(button, "onClick");
    const [frame] = iframes(tree);
    expect(frame.props.src).toBe(
      "https://www.youtube-nocookie.com/embed/dBL5_4EQ47M?rel=0&modestbranding=1&playsinline=1&autoplay=1"
    );
    expect(frame.props.title).toBe("Video: OSINT class");
    expect(frame.props.allow).toContain("autoplay");
    await tree.unmount();
  });

  it("falls back to the always-present hq thumbnail when maxres is missing", async () => {
    const tree = await renderTree(<LiteYouTubeEmbed videoId="dBL5_4EQ47M" title="x" />);
    const poster = tree.find((node) => node.type === "img");
    await act(() => poster.props.onLoad({ currentTarget: { naturalWidth: 120 } }));
    expect(tree.find((node) => node.type === "img").props.src).toBe("https://i.ytimg.com/vi/dBL5_4EQ47M/hqdefault.jpg");
    await tree.unmount();
  });

  it("renders nothing for an invalid id", () => {
    expect(renderToStaticMarkup(<LiteYouTubeEmbed videoId={'"><script>'} title="x" />)).toBe("");
  });

  it("labels a live stream as such", () => {
    expect(renderToStaticMarkup(<LiteYouTubeEmbed videoId="LiVe1234567" title="Live" isLive />)).toContain(
      'aria-label="Watch the live stream: Live"'
    );
  });
});

describe("YouTubeShowcase", () => {
  it("features the latest upload when not live, with its date and JSON-LD", () => {
    const html = renderToStaticMarkup(
      <YouTubeShowcase model={normalizeYouTubePayload(payload())} now={NOW} withJsonLd />
    );
    expect(html).toContain("Featured video");
    expect(html).toContain("Destroying the Propaganda Machine");
    expect(html.toLowerCase()).toContain('datetime="2026-10-11t19:36:58.000z"');
    expect(html).toContain("11 Oct 2026");
    expect(html).not.toContain("Live now");
    expect(html).not.toContain("<iframe");
    expect(html).toContain('"@type":"VideoObject"');
    expect(html).toContain('href="https://www.youtube.com/@thesy3d?sub_confirmation=1"');
    expect(html).toContain("Subscribe on YouTube");
    expect(html).toContain("View channel");
  });

  it("leads with the live stream and a join button when live", () => {
    const html = renderToStaticMarkup(<YouTubeShowcase model={normalizeYouTubePayload(livePayload())} now={NOW} withJsonLd />);
    expect(html).toContain("Live now");
    expect(html).toContain("Join the live stream");
    expect(html).toContain("Sunday OSINT live");
    expect(html).toContain("https://i.ytimg.com/vi/LiVe1234567/");
    // JSON-LD keeps describing the featured upload (a live BroadcastEvent needs a start time we do not have).
    expect(html).toContain('"embedUrl":"https://www.youtube-nocookie.com/embed/hWFA4oNF7gk"');
    expect(html).not.toContain("embed/LiVe1234567");
  });

  it("plays a picked video in the main player straight away", async () => {
    const tree = await renderTree(<YouTubeShowcase model={normalizeYouTubePayload(payload())} now={NOW} />);
    const card = tree.getByLabel("button", "Play FREE LIVE Advanced OSINT Class");
    expect(card.props["aria-pressed"]).toBe(false);
    await fire(card, "onClick");
    const [frame] = iframes(tree);
    expect(frame.props.src).toContain("/embed/dBL5_4EQ47M?");
    expect(tree.getByLabel("button", "Play FREE LIVE Advanced OSINT Class").props["aria-pressed"]).toBe(true);
    expect(textOf(tree.container.children[0])).toContain("Now playing");
    await tree.unmount();
  });

  it("starts the live stream from the join button", async () => {
    const tree = await renderTree(<YouTubeShowcase model={normalizeYouTubePayload(livePayload())} now={NOW} />);
    expect(iframes(tree)).toHaveLength(0);
    await fire(tree.getByLabel("button", "Join the live stream"), "onClick");
    expect(iframes(tree)[0].props.src).toContain("/embed/LiVe1234567?");
    expect(iframes(tree)[0].props.title).toBe("Live stream: Sunday OSINT live");
    await tree.unmount();
  });
});

function storeWith(response) {
  const fetcher = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { data: { success: true, data: response } };
  });
  const store = createYouTubeStore({
    fetcher,
    enabled: true,
    doc: null,
    timers: { set: () => 1, clear: () => {} },
  });
  return { store, fetcher };
}

async function renderSection(store) {
  const tree = await renderTree(
    <MemoryRouter>
      <YouTubeSection store={store} now={NOW} />
    </MemoryRouter>
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return tree;
}

describe("YouTubeSection (landing)", () => {
  it("renders the Watch section with an anchor when there is something to play", async () => {
    const { store } = storeWith(payload());
    const tree = await renderSection(store);
    const section = tree.find((node) => node.type === "section");
    expect(section.props.id).toBe("watch");
    expect(tree.text()).toContain("Watch Al Syed");
    expect(tree.text()).toContain("YouTube · @thesy3d");
    await tree.unmount();
  });

  it("shows the live badge in the heading while live", async () => {
    const { store } = storeWith(livePayload());
    const tree = await renderSection(store);
    expect(tree.text()).toContain("Live now");
    await tree.unmount();
  });

  it.each([
    ["disabled", payload({ enabled: false, available: false })],
    ["unavailable", payload({ available: false, featured: null, latest: [] })],
    ["unreachable", new Error("network")],
  ])("is hidden entirely when %s", async (_label, response) => {
    const { store } = storeWith(response);
    const tree = await renderSection(store);
    expect(tree.container.children).toHaveLength(0);
    await tree.unmount();
  });

  it("keeps its space with a skeleton while loading", async () => {
    const store = createYouTubeStore({
      fetcher: () => new Promise(() => {}),
      enabled: true,
      doc: null,
      timers: { set: () => 1, clear: () => {} },
    });
    const tree = await renderSection(store);
    expect(tree.find((node) => String(node.props?.className || "").includes("yt-skeleton"))).not.toBeNull();
    expect(tree.find((node) => node.type === "section")).toBeNull();
    await tree.unmount();
  });
});

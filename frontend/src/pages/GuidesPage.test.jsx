import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AuthContext } from "../context/AuthContext";
import { act, renderTree } from "../test-utils/renderTree";
import { GuidesPageContent, resolveSelectedGuideId } from "./GuidesPage";

// The real surface binds document-level fullscreen listeners (no DOM in these tests).
vi.mock("../components/ProtectedPlaybackSurface", () => ({
  default: ({ children }) => <div data-testid="playback-surface">{children}</div>,
}));

const guides = [
  {
    id: 1,
    title: "How to Use the Dashboard",
    description: "Walk through the core dashboard controls.",
  },
  {
    id: 2,
    title: "How to Join Live Classes",
    description: "See the live-class join flow.",
  },
];

function content(props) {
  return (
    <AuthContext.Provider
      value={{
        user: { id: 9, full_name: "Guide Tester", email: "guide@test.com" },
        isAuthenticated: true,
      }}
    >
      <StaticRouter location="/guides">
        <GuidesPageContent
          guides={[]}
          selectedGuide={null}
          videoUrl=""
          loading={false}
          loadingVideo={false}
          error=""
          videoError=""
          onSelectGuide={() => {}}
          onVideoError={() => {}}
          {...props}
        />
      </StaticRouter>
    </AuthContext.Provider>
  );
}

const renderGuidesPageContent = (props) => renderToStaticMarkup(content(props));

describe("GuidesPage", () => {
  it("renders the selected guide, player and the guide list", () => {
    const html = renderGuidesPageContent({
      guides,
      selectedGuide: guides[0],
      videoUrl: "https://videos.example.com/guide.mp4",
    });

    expect(html).toContain("Guide 1 of 2");
    expect(html).toContain("How to Use the Dashboard");
    expect(html).toContain("Walk through the core dashboard controls.");
    expect(html).toContain("Now playing");
    expect(html).toContain("All guides");
    expect(html).toContain("How to Join Live Classes");
    expect(html).toContain('src="https://videos.example.com/guide.mp4"');
    expect(html).toContain("Next guide");
    // Only the playing guide is marked current.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("shows a loading message in the stage while the signed URL is fetched", () => {
    const html = renderGuidesPageContent({ guides, selectedGuide: guides[1], loadingVideo: true });
    expect(html).toContain("Loading video");
    expect(html).not.toContain("<video");
    // Last guide: no "Next guide" action.
    expect(html).not.toContain("Next guide");
  });

  it("renders the empty state when no guides are published", () => {
    const html = renderGuidesPageContent({ guides: [] });
    expect(html).toContain("No guides yet");
  });

  it("shows a skeleton while loading and a retryable error when the list fails", () => {
    expect(renderGuidesPageContent({ loading: true })).toContain("Loading guides");
    const html = renderGuidesPageContent({ error: "Network down", onRetry: () => {} });
    expect(html).toContain("Guides could not be loaded.");
    expect(html).toContain("Network down");
    expect(html).toContain("Try again");
  });

  it("shows playback problems with a retry action", () => {
    const html = renderGuidesPageContent({
      guides,
      selectedGuide: guides[0],
      videoError: "This guide video is not available right now.",
      onRetryVideo: () => {},
    });
    expect(html).toContain("This video can&#x27;t play right now.");
    expect(html).toContain("Try again");
  });

  it("selects a guide from the list and from Next guide", async () => {
    const onSelectGuide = vi.fn();
    const tree = await renderTree(content({ guides, selectedGuide: guides[0], onSelectGuide }));
    await act(() => tree.getByLabel("button", "How to Join Live Classes").props.onClick());
    expect(onSelectGuide).toHaveBeenLastCalledWith(guides[1]);
    await act(() => tree.getByLabel("button", "Next guide").props.onClick());
    expect(onSelectGuide).toHaveBeenCalledTimes(2);
    expect(onSelectGuide).toHaveBeenLastCalledWith(guides[1]);
    await tree.unmount();
  });

  it("keeps the current guide after a reload, falling back to the first guide", () => {
    expect(resolveSelectedGuideId(guides, "2")).toBe(2);
    expect(resolveSelectedGuideId(guides, "99")).toBe(1);
    expect(resolveSelectedGuideId(guides, null)).toBe(1);
    expect(resolveSelectedGuideId([], "2")).toBe(null);
  });
});

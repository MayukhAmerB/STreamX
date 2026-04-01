import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { AuthContext } from "../context/AuthContext";
import { GuidesPageContent } from "./GuidesPage";

function renderGuidesPageContent(props) {
  return renderToStaticMarkup(
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

describe("GuidesPage", () => {
  it("renders the selected guide and player state", () => {
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

    const html = renderGuidesPageContent({
      guides,
      selectedGuide: guides[0],
      videoUrl: "https://videos.example.com/guide.mp4",
    });

    expect(html).toContain("Guide Viewer");
    expect(html).toContain("How to Use the Dashboard");
    expect(html).toContain("Now Playing");
    expect(html).toContain("Guide Library");
    expect(html).toContain('src="https://videos.example.com/guide.mp4"');
  });

  it("renders the empty state when no guides are published", () => {
    const html = renderGuidesPageContent({ guides: [] });

    expect(html).toContain("No guides published yet");
    expect(html).toContain("Guide Panel");
  });
});

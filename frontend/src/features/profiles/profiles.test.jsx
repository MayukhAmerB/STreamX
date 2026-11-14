// Student profiles UI (WS-PROFILES): model helpers, the rich-text renderer
// (no HTML injection, safe links only) and the profile view.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

import {
  describePath,
  groupFindings,
  missingBlockTypes,
  moveBlock,
  newBlock,
  pathHasFinding,
  prefixLines,
  removeBlock,
  toDocument,
  updateBlock,
  wrapSelection,
} from "./profileModel";
import ProfileView from "./ProfileView";
import { ProfileMessage } from "./PublicProfilePage";
import RichText, { isSafeHref, LINK_REL } from "./RichText";
import { profilePublicRoutes, profileShellRoutes, PROFILE_EDITOR_PATH, PROFILE_PUBLIC_PATH } from "./routes";

const render = (node) => renderToStaticMarkup(<StaticRouter location="/u/quiet_falcon">{node}</StaticRouter>);

const SAMPLE = {
  handle: "quiet_falcon",
  url: "/u/quiet_falcon",
  preview: false,
  visibility: "members",
  is_owner: false,
  can_report: true,
  status: "active",
  theme: { accent: "gold", align: "center", banner: "lines", tagline: "hand" },
  header: { display_name: "Quiet Falcon", tagline: "Learning to find what others miss", avatar: null, banner: null, real_name: null },
  blocks: [
    {
      id: "bio",
      type: "bio",
      title: "About",
      doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "I study " }, { type: "text", text: "OSINT", marks: ["bold"] }] }] },
    },
    { id: "badges", type: "badges", title: "Badges", items: [{ key: "first_lecture", title: "First Lecture", description: "Complete your first lecture.", tier: "bronze" }] },
    { id: "skills", type: "skills", title: "Skills", items: [{ name: "Recon", level: "confident" }, { name: "Geolocation", level: "learning" }] },
    { id: "writeups", type: "writeups", title: "Write-ups", items: [{ title: "Finding the lighthouse", summary: "Shadows and a ferry timetable.", url: "https://github.com/quiet-falcon/lighthouse", host: "github.com", tags: ["geoint"] }] },
    { id: "links", type: "links", title: "Links", items: [{ label: "GitHub", url: "https://github.com/quiet-falcon", host: "github.com" }, { label: "Bad", url: "javascript:alert(1)", host: "" }] },
  ],
};

describe("profile model", () => {
  const blocks = ["bio", "skills", "links"].map(newBlock);

  it("moves, updates and removes blocks without mutating", () => {
    expect(moveBlock(blocks, 0, 1).map((b) => b.type)).toEqual(["skills", "bio", "links"]);
    expect(moveBlock(blocks, 0, -1)).toBe(blocks);
    expect(moveBlock(blocks, 2, 1)).toBe(blocks);
    expect(updateBlock(blocks, 1, { title: "Tools" })[1].title).toBe("Tools");
    expect(blocks[1].title).toBe("");
    expect(removeBlock(blocks, 0).map((b) => b.type)).toEqual(["skills", "links"]);
    expect(missingBlockTypes(blocks)).toEqual(["badges", "writeups", "gallery"]);
  });

  it("builds the API document without UI-only keys", () => {
    const doc = toDocument({
      theme: { accent: "white" },
      header: { display_name: "x", tagline: "", avatar_id: "", banner_id: null, extra: 1 },
      blocks: [
        { id: "bio", type: "bio", source: "hi", doc: { type: "doc", content: [] } },
        { id: "links", type: "links", items: [{ label: "a", url: "https://a.example", host: "a.example" }] },
      ],
    });
    expect(doc.header).toEqual({ display_name: "x", tagline: "", avatar_id: null, banner_id: null });
    expect(doc.blocks[0].doc).toBeUndefined();
    expect(doc.blocks[1].items[0]).toEqual({ label: "a", url: "https://a.example" });
  });

  it("names finding paths and groups them", () => {
    const draft = { blocks: [newBlock("bio"), { ...newBlock("writeups"), title: "Cases" }] };
    expect(describePath("header.tagline", draft)).toBe("Tagline");
    expect(describePath("blocks[0].source", draft)).toBe("About: About text");
    expect(describePath("blocks[1].items[2].summary", draft)).toBe("Cases, item 3: Summary");
    expect(describePath("image.metadata.Artist", draft)).toBe("Image details (metadata)");
    const rows = groupFindings(
      [
        { path: "blocks[0].source", label: "a phone number", excerpt: "98••••10" },
        { path: "blocks[0].source", label: "an email address", excerpt: "ra•••om" },
        { path: "header.tagline", label: "your real name, email or phone number", excerpt: "Ra•••ma" },
      ],
      draft
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].labels).toEqual(["a phone number", "an email address"]);
    expect(pathHasFinding([{ path: "blocks[1].items[0].url" }], "blocks[1]")).toBe(true);
    expect(pathHasFinding([{ path: "blocks[10].source" }], "blocks[1]")).toBe(false);
  });

  it("formats the bio with Markdown helpers", () => {
    expect(wrapSelection("hello world", 6, 11, "**")).toEqual({ value: "hello **world**", start: 8, end: 13 });
    expect(wrapSelection("", 0, 0, "[", "](https://)", "link text").value).toBe("[link text](https://)");
    expect(prefixLines("a\nb", 0, 3, "- ").value).toBe("- a\n- b");
  });
});

describe("RichText", () => {
  it("renders React elements only and escapes text", () => {
    const html = renderToStaticMarkup(
      <RichText
        doc={{
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "<img src=x onerror=alert(1)>" }] },
            { type: "html", content: "<script>alert(1)</script>" },
            { type: "list", items: [[{ type: "text", text: "one", marks: ["code"] }]] },
          ],
        }}
      />
    );
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("<code");
  });

  it("only links https URLs, always with nofollow ugc noopener", () => {
    const html = renderToStaticMarkup(
      <RichText
        doc={{
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "link", text: "ok", href: "https://example.com/a" },
                { type: "link", text: "bad", href: "javascript:alert(1)" },
                { type: "link", text: "plain", href: "http://example.com" },
              ],
            },
          ],
        }}
      />
    );
    expect(html).toContain(`rel="${LINK_REL}"`);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("javascript:");
    expect(isSafeHref("https://user:pw@example.com")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(isSafeHref("https://github.com/x")).toBe(true);
  });

  it("renders nothing for an empty or malformed document", () => {
    expect(renderToStaticMarkup(<RichText doc={null} />)).toBe("");
    expect(renderToStaticMarkup(<RichText doc={{ type: "doc", content: "x" }} />)).toBe("");
  });
});

describe("ProfileView", () => {
  it("shows the owner's arrangement with the handle, never a real name by default", () => {
    const html = render(<ProfileView profile={SAMPLE} />);
    expect(html).toContain("Quiet Falcon");
    expect(html).toContain("@quiet_falcon");
    expect(html).toContain("Student profile");
    expect(html).toContain("data-hand-period");
    expect(html).toContain("Learning to find what others miss");
    const order = ["About", "Badges", "Skills", "Write-ups", "Links"].map((title) => html.indexOf(`>${title}</h2>`));
    expect(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]))).toBe(true);
    expect(html).toContain("Confident");
    expect(html).toContain("Report profile");
  });

  it("drops unsafe links and marks every external link", () => {
    const html = render(<ProfileView profile={SAMPLE} />);
    expect(html).not.toContain("javascript:");
    const anchors = html.match(/<a [^>]*>/g) || [];
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const anchor of anchors) {
      expect(anchor).toContain(`rel="${LINK_REL}"`);
      expect(anchor).toMatch(/href="https:\/\//);
    }
  });

  it("follows the palette law (no hue utility classes)", () => {
    const html = render(<ProfileView profile={SAMPLE} />);
    expect(html).not.toMatch(/\b(?:text|bg|border)-(?:red|green|blue|yellow|orange|purple|pink|emerald|sky|cyan|teal|lime|amber|violet|indigo|rose|fuchsia)-/);
  });

  it("shows the real name only when the API sends it", () => {
    const html = render(<ProfileView profile={{ ...SAMPLE, header: { ...SAMPLE.header, real_name: "R. Sharma" } }} />);
    expect(html).toContain("R. Sharma");
  });

  it("hides the report button for the owner and in previews", () => {
    expect(render(<ProfileView profile={{ ...SAMPLE, can_report: false }} />)).not.toContain("Report profile");
    expect(render(<ProfileView profile={SAMPLE} showReport={false} />)).not.toContain("Report profile");
  });

  it("aligns left when the owner picks it", () => {
    const html = render(<ProfileView profile={{ ...SAMPLE, theme: { ...SAMPLE.theme, align: "left" } }} />);
    expect(html).toContain("items-start text-left");
  });
});

describe("routes and messages", () => {
  it("declares the public and editor paths", () => {
    expect(PROFILE_PUBLIC_PATH).toBe("/u/:handle");
    expect(PROFILE_EDITOR_PATH).toBe("/profile/public");
    expect(profilePublicRoutes()[0].props.path).toBe("/u/:handle");
    expect(profileShellRoutes()[0].props.path).toBe("/profile/public");
  });

  it("renders a calm message band", () => {
    const html = render(<ProfileMessage tagline="Members only" title="Sign in to view">Body</ProfileMessage>);
    expect(html).toContain("<h1");
    expect(html).toContain("Members only");
    expect(html).toContain("data-hand-period");
  });
});

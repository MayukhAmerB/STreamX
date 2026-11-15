import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { act, renderTree, textOf } from "../test-utils/renderTree";
import { OsintToolsView, ToolCard } from "./OsintToolsPage";

// Carbon notifications run a dev-only DOM probe for interactive children that the
// in-memory renderer's plain host nodes cannot satisfy; a plain stand-in suffices.
vi.mock("@carbon/react", async (importOriginal) => {
  const actual = await importOriginal();
  const InlineNotification = ({ title, subtitle }) => (
    <div role="status">
      {title} {subtitle}
    </div>
  );
  return { ...actual, InlineNotification };
});

for (const name of ["HTMLButtonElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLAnchorElement"]) {
  globalThis[name] ??= class {};
}

const pressed = (tree) =>
  tree.all((node) => node.props?.["aria-pressed"] === true).map((node) => textOf(node));

describe("OsintToolsPage", () => {
  it("lists every tool grouped by category with search and clue filters", () => {
    const html = renderToStaticMarkup(<OsintToolsView />);
    expect(html).toContain("OSINT tools");
    expect(html).toContain('placeholder="Search 72 tools"');
    expect(html).toContain("What clue do you have?");
    expect(html).toContain("All tools");
    expect(html).toContain("Username or email");
    expect(html).toContain("Not sure yet");
    expect(html).toContain("72 tools");
    expect(html).toContain("Directories and search starting points");
    expect(html).toContain("Enterprise OSINT and threat platforms");
    expect(html).toContain("For lawful, authorized research only.");
    expect(html).not.toContain("Clear filters");
  });

  it("opens linked tools in a new tab and marks reference-only tools", () => {
    const linked = renderToStaticMarkup(
      <ToolCard tool={{ name: "OSINT Framework", type: "Directory", use: "Map.", url: "https://osintframework.com/" }} />
    );
    expect(linked).toContain('href="https://osintframework.com/"');
    expect(linked).toContain('target="_blank"');
    expect(linked).toContain('rel="noreferrer"');
    expect(linked).toContain('aria-label="Open OSINT Framework (opens in a new tab)"');
    expect(linked).toContain(">Open<");

    const reference = renderToStaticMarkup(<ToolCard tool={{ name: "Maltego", type: "Link analysis", use: "Graphs." }} />);
    expect(reference).not.toContain("href=");
    expect(reference).toContain("Reference only");
  });

  it("filters by clue chip, shows its guidance and clears back to all tools", async () => {
    const tree = await renderTree(<OsintToolsView />);
    expect(pressed(tree)).toEqual(["All tools"]);

    await act(() => tree.getByLabel("button", "Phone or vehicle").props.onClick({}));
    expect(pressed(tree)).toEqual(["Phone or vehicle"]);
    expect(tree.text()).toContain("Phone and vehicle lookups");
    expect(tree.text()).toContain("Start here:");
    expect(tree.text()).toContain("Use with care.");
    expect(tree.text()).toContain("4 tools");

    // Tapping the selected chip again returns to everything.
    await act(() => tree.getByLabel("button", "Phone or vehicle").props.onClick({}));
    expect(pressed(tree)).toEqual(["All tools"]);
    expect(tree.text()).toContain("72 tools");
    await tree.unmount();
  });

  it("searches within the selected clue and hides its guidance while searching", () => {
    const html = renderToStaticMarkup(<OsintToolsView initialClueId="phone-or-vehicle" initialQuery="vahan" />);
    expect(html).not.toContain("Start here:");
    expect(html).toContain("matching “vahan”");
    expect(html).toContain("Clear filters");
  });

  it("shows an empty state for a search with no matches and recovers", async () => {
    const tree = await renderTree(<OsintToolsView initialQuery="zzzz" />);
    expect(tree.text()).toContain("No tools found");
    expect(tree.text()).toContain("No tools match “zzzz”. Try another word.");
    await act(() => tree.getByLabel("button", "Show all tools").props.onClick());
    expect(tree.text()).toContain("72 tools");
    expect(tree.text()).not.toContain("No tools found");
    await tree.unmount();
  });

  it("narrows results while typing in the search box", async () => {
    const tree = await renderTree(<OsintToolsView />);
    const input = tree.find((node) => node.type === "input" && node.props.role === "searchbox")
      || tree.find((node) => node.type === "input");
    await act(() => input.props.onChange({ target: { value: "spiderfoot" } }));
    expect(tree.text()).toContain("1 tool matching “spiderfoot”");
    expect(tree.text()).toContain("SpiderFoot");
    expect(tree.text()).toContain("Clear filters");
    await tree.unmount();
  });
});

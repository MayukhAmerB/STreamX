import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { fire, renderTree } from "../test-utils/renderTree";
import EmptyState from "./EmptyState";
import InlineNotification, { formatClockTime } from "./InlineNotification";

const html = (element) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

describe("site kit InlineNotification", () => {
  it("announces errors and warnings as alerts, info and success politely", () => {
    expect(html(<InlineNotification kind="error" title="x" />)).toMatch(/^<div role="alert"/);
    expect(html(<InlineNotification kind="warning" title="x" />)).toMatch(/^<div role="alert"/);
    expect(html(<InlineNotification kind="info" title="x" />)).toMatch(/^<div role="status"/);
    expect(html(<InlineNotification kind="success" title="x" />)).toMatch(/^<div role="status"/);
    expect(html(<InlineNotification kind="bogus" title="x" />)).toContain("sk-notification--info");
  });

  it("is named by its title", () => {
    const markup = html(<InlineNotification kind="error" title="Live classes could not load" subtitle="Check your connection." />);
    const labelledBy = markup.match(/aria-labelledby="([^"]+)"/)[1];
    expect(markup).toContain(`<p id="${labelledBy}" class="sk-notification__title">Live classes could not load</p>`);
    expect(markup).toContain("Check your connection.");
  });

  it("offers Retry, busy while retrying", async () => {
    const onRetry = vi.fn();
    const tree = await renderTree(
      <MemoryRouter>
        <InlineNotification kind="error" title="Feed unavailable" onRetry={onRetry} />
      </MemoryRouter>
    );
    await fire(tree.getByLabel("button", "Retry"), "onClick");
    expect(onRetry).toHaveBeenCalledTimes(1);
    await tree.unmount();

    const busy = html(<InlineNotification kind="error" title="x" onRetry={() => {}} retrying />);
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain(">Retrying</span>");
  });

  it("says when cached data was last updated, and can carry one action and a close button", () => {
    const when = new Date(2026, 10, 13, 9, 5);
    const markup = html(
      <InlineNotification
        kind="warning"
        title="Showing saved courses"
        lastUpdated={when}
        action={<a href="/courses/1/live">Join now</a>}
        onClose={() => {}}
      />
    );
    expect(markup).toContain(`Last updated ${formatClockTime(when)}`);
    expect(markup).toContain('<a href="/courses/1/live">Join now</a>');
    expect(markup).toContain('aria-label="Dismiss notification"');
    expect(formatClockTime("not a date")).toBe("");
  });
});

describe("site kit EmptyState", () => {
  it("says one calm sentence with at most one real action", () => {
    const markup = html(
      <EmptyState title="Pentesting opens soon" body="We will announce the first batch here." action={{ label: "Contact us", href: "/contact" }} />
    );
    expect(markup).toContain('<h3 class="sk-empty__title">Pentesting opens soon</h3>');
    expect(markup).toContain('href="/contact"');
    expect(markup.match(/<a /g)).toHaveLength(1);
  });

  it("can open a modal instead of linking, and drops actions that lead nowhere", async () => {
    const onClick = vi.fn();
    const tree = await renderTree(
      <MemoryRouter>
        <EmptyState headingLevel={2} title="No courses are listed yet" action={{ label: "Send an enquiry", onClick }} />
      </MemoryRouter>
    );
    expect(tree.find((node) => node.type === "h2")).not.toBeNull();
    await fire(tree.getByLabel("button", "Send an enquiry"), "onClick");
    expect(onClick).toHaveBeenCalledTimes(1);
    await tree.unmount();
    expect(html(<EmptyState title="Nothing" action={{ label: "Dead end" }} />)).not.toContain("sk-empty__action");
  });
});

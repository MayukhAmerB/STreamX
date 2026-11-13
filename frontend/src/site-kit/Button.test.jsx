import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { fire, renderTree } from "../test-utils/renderTree";
import Button from "./Button";
import Link from "./Link";

const html = (element) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

describe("site kit Button", () => {
  it("defaults to a large primary button that never submits by accident", () => {
    expect(html(<Button>Browse courses</Button>)).toBe(
      '<button type="button" class="sk-button sk-button--primary sk-button--lg"><span class="sk-button__label">Browse courses</span></button>'
    );
  });

  it("renders every kind and both sizes, falling back for unknown values", () => {
    for (const kind of ["primary", "secondary", "tertiary", "ghost"]) {
      expect(html(<Button kind={kind}>x</Button>)).toContain(`sk-button--${kind}`);
    }
    expect(html(<Button size="md">x</Button>)).toContain("sk-button--md");
    expect(html(<Button kind="neon" size="xl">x</Button>)).toContain("sk-button--primary sk-button--lg");
  });

  it("links in-app paths through the router and opens http links in a new tab", () => {
    expect(html(<Button href="/courses">Browse</Button>)).toMatch(/^<a class="sk-button[^"]*" href="\/courses">/);
    const external = html(<Button href="https://labs.alsyedinitiative.com">Labs</Button>);
    expect(external).toContain('href="https://labs.alsyedinitiative.com" target="_blank" rel="noopener noreferrer"');
    expect(external).toContain("(opens in a new tab)");
    expect(html(<Button href="mailto:contact@adlfront.com">Mail</Button>)).not.toContain("target=");
  });

  it("disables without the native attribute: focusable, no href, reason via aria-describedby", () => {
    const markup = html(
      <Button href="/courses/1/live" disabled disabledReason="No live class scheduled">
        Join live
      </Button>
    );
    expect(markup).not.toContain("href=");
    expect(markup).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(markup).toContain('aria-disabled="true"');
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)[1];
    expect(markup).toContain(`<span id="${describedBy}" role="tooltip" class="sk-tooltip">No live class scheduled</span>`);
  });

  it("ignores activation while disabled or loading", async () => {
    const onClick = vi.fn();
    const tree = await renderTree(
      <MemoryRouter>
        <Button disabled disabledReason="Not yet" onClick={onClick}>
          A
        </Button>
        <Button loading onClick={onClick}>
          B
        </Button>
      </MemoryRouter>
    );
    const [disabled, loading] = tree.all((node) => node.type === "button");
    const preventDefault = vi.fn();
    await fire(disabled, "onClick", { preventDefault });
    await fire(loading, "onClick", { preventDefault });
    expect(onClick).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    await tree.unmount();
  });

  it("shows loading inline with aria-busy and never submits a form while busy", () => {
    const markup = html(
      <Button type="submit" loading loadingText="Sending">
        Send
      </Button>
    );
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('<span class="sk-button__spinner" aria-hidden="true"></span>');
    expect(markup).toContain(">Sending</span>");
  });

  it("keeps the caller's aria-describedby next to the disabled reason", () => {
    const markup = html(
      <Button disabled disabledReason="Waiting for the virus scan to finish" aria-describedby="help">
        Submit
      </Button>
    );
    expect(markup).toMatch(/aria-describedby="help [^"]+"/);
  });
});

describe("site kit Link", () => {
  it("routes in-app paths and marks new-tab links for screen readers", () => {
    expect(html(<Link href="/about">About</Link>)).toBe('<a class="sk-link" href="/about"><span>About</span></a>');
    const external = html(<Link href="https://www.youtube.com/@thesy3d">YouTube</Link>);
    expect(external).toContain('target="_blank" rel="noopener noreferrer"');
    expect(external).toContain('<span class="sk-visually-hidden"> (opens in a new tab)</span>');
    expect(html(<Link href="/watch" arrow>All videos</Link>)).toContain('class="sk-link__icon"');
    expect(html(<Link href="/terms" inline>terms</Link>)).toContain('class="sk-link sk-link--inline"');
  });
});

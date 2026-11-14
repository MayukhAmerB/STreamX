// WS-A: the Carbon prune pass removes only dead output from the Console bundle.
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import carbonPrune from "../../scripts/postcss-carbon-prune.mjs";

const CONSOLE = "/repo/frontend/src/features/app-shell/styles/carbon-app.scss";
const run = async (css, from = CONSOLE) => (await postcss([carbonPrune()]).process(css, { from })).css;

describe("postcss carbon prune (Console CSS budget)", () => {
  it("drops legacy high-contrast media, the dead :root block, unused variants and token families", async () => {
    const out = await run(`
      .cds-app :root { --cds-layout-size-height-xs: 1.5rem; }
      @media screen and (-ms-high-contrast: active) { .cds-app .cds--btn { outline: 1px solid; } }
      .cds-app .cds--popover--border .cds--popover-content { outline: 1px solid; }
      .cds-app .cds--popover-content, .cds-app .cds--popover--border .cds--popover-caret { color: red; }
      .cds-app .cds--modal--slug .cds--modal-container { background: blue; }
      .cds-app { --cds-ai-aura-start: red; --cds-chat-bubble: red; --cds-text-primary: #f4f4f4; }
      @media (forced-colors: active) { .cds-app .cds--btn { outline: 1px solid; } }
      .cds-app .cds--btn { color: white; }
    `);
    expect(out).not.toContain("-ms-high-contrast");
    expect(out).not.toContain(":root");
    expect(out).not.toContain("popover--border");
    expect(out).not.toContain("modal--slug");
    expect(out).not.toContain("--cds-ai-");
    expect(out).not.toContain("--cds-chat-");
    expect(out).toContain("--cds-text-primary: #f4f4f4");
    expect(out).toContain(".cds-app .cds--popover-content {");
    expect(out).toContain("forced-colors");
    expect(out).toContain(".cds-app .cds--btn { color: white; }");
  });

  it("never touches any other stylesheet", async () => {
    const css = "@media screen and (-ms-high-contrast: active) { .x { color: red; } } .a { --cds-ai-x: 1; }";
    expect(await run(css, "/repo/frontend/src/site-kit/site-kit.css")).toBe(css);
  });
});

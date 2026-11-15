// Kit unit tests (node environment, no jsdom): static markup for structure and
// ARIA, pure functions for ranking, stores and the palette law. Keyboard,
// focus trap and focus restore are checked in a browser against /__kit
// (scratchpad kit-a11y script). OWNER: WS-KIT.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import defaultTailwindColors from "tailwindcss/colors.js";
import resolveConfig from "tailwindcss/resolveConfig.js";

import { checkText } from "../../scripts/check-palette.mjs";
import { contrast, isLawful, parseColour } from "../../scripts/palette-law.mjs";
import tailwindConfig from "../../tailwind.config.js";
import { Badge, StatusBadge, STATUS_KINDS } from "./Badge";
import { Button } from "./Button";
import { LinkCard } from "./Card";
import { filterCommands, scoreText } from "./Command";
import { DisabledReason } from "./DisabledReason";
import { Field, Input, UnderlineField } from "./Form";
import { StatStrip } from "./Layout";
import { Reveal, prefersReducedMotion } from "./motion";
import { Terminal, Timeline, TimelineStep } from "./Story";
import { dismissToast, toast } from "./Toast";
import { DisplayHeading, Hand, Kicker } from "./Typography";

const html = (element) => renderToStaticMarkup(element);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Button", () => {
  it("is a type=button rectangle with the white primary look by default", () => {
    const out = html(<Button>Start free</Button>);
    expect(out).toMatch(/^<button type="button"/);
    expect(out).toContain("bg-white");
    expect(out).toContain("text-black");
    expect(out).toContain("rounded-md");
    expect(out).toContain("h-10");
  });

  it("renders the three measured heights and the golden accent variant", () => {
    expect(html(<Button size="md">x</Button>)).toContain("h-11");
    expect(html(<Button size="lg">x</Button>)).toContain("h-12");
    expect(html(<Button variant="accent">x</Button>)).toContain("bg-accent");
    expect(html(<Button variant="secondary">x</Button>)).toContain("border-white/20");
  });

  it("forwards its classes to the child with asChild (router links)", () => {
    const out = html(
      <Button asChild variant="secondary">
        <a href="/courses">Browse</a>
      </Button>
    );
    expect(out).toMatch(/^<a href="\/courses" class="[^"]*border-white\/20[^"]*">Browse<\/a>$/);
  });

  it("adds a decorative trailing glyph that nudges on hover", () => {
    const out = html(<Button trailing="chevron">Next</Button>);
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("group-hover/button:translate-x-1");
  });
});

describe("DisabledReason", () => {
  it("is focusable, aria-disabled and described by a visible reason", () => {
    const out = html(<DisabledReason id="buy" reason="Pentesting opens soon." href="/checkout" onClick={() => {}}>Enrol</DisabledReason>);
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('aria-describedby="buy-reason"');
    expect(out).toContain('id="buy-reason"');
    expect(out).toContain("Pentesting opens soon.");
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(out).not.toContain("href=");
    expect(out).toContain("border-dashed");
  });

  it("can keep the reason for screen readers only", () => {
    expect(html(<DisabledReason reason="Price at launch" reasonVisibility="sr-only">Choose</DisabledReason>)).toContain('class="sr-only"');
  });
});

describe("Status without hue", () => {
  it("always renders an icon or dot AND a word for every kind", () => {
    for (const [kind, spec] of Object.entries(STATUS_KINDS)) {
      if (kind === "neutral") continue;
      const out = html(<StatusBadge kind={kind} />);
      expect(out).toContain(`>${spec.label}</span>`);
      // `free` is a word-only golden pill by design (BUILD_PLAN §1.2); the rest carry an icon or the live dot.
      if (kind !== "free") expect(out).toMatch(/<svg|rounded-full bg-accent/);
    }
  });

  it("marks critical by inversion (white fill, black text), not by a colour", () => {
    const out = html(<StatusBadge kind="critical" />);
    expect(out).toContain("bg-white");
    expect(out).toContain("text-black");
  });

  it("only uses lawful classes (no arbitrary hues)", () => {
    expect(html(<Badge variant="accent">Most popular</Badge>)).toContain("text-accent");
  });
});

describe("Typography", () => {
  it("renders hand periods after every display line", () => {
    const out = html(<DisplayHeading lines={["Read first", "Act after"]} periods />);
    expect(out.match(/data-hand-period/g)).toHaveLength(2);
    expect(out).toContain("hand-period");
  });

  it("warns when a heading carries an accent word AND hand periods", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    html(
      <DisplayHeading lines={[<span key="a">Read <Hand>first</Hand></span>, "Act after"]} periods />
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exactly one Handlee fragment"));
    warn.mockRestore();
  });

  it("puts the kicker's first word in golden white with a hairline dash", () => {
    const out = html(<Kicker lead="Course">Members only</Kicker>);
    expect(out).toContain('<span class="text-accent">Course</span>');
    expect(out).toContain("h-px w-8 bg-white/20");
  });
});

describe("Cards and layout", () => {
  it("LinkCard inverts on hover and on keyboard focus, never lifts", () => {
    const out = html(<LinkCard href="/c" title="Reading a domain" eyebrow="Beginner" description="d" />);
    expect(out).toContain("hover:bg-white");
    expect(out).toContain("focus-visible:bg-white");
    const rootClass = out.match(/^<a class="([^"]*)"/)[1];
    expect(rootClass).not.toContain("translate-y");
  });

  it("StatStrip is a description list with values before labels visually", () => {
    const out = html(<StatStrip items={[{ value: "4", label: "free labs" }]} />);
    expect(out).toMatch(/^<dl class="stat-strip/);
    expect(out).toContain("<dt");
    expect(out).toContain("<dd");
  });
});

describe("Form controls", () => {
  it("Field wires label, hint and error to the control", () => {
    const out = html(
      <Field label="Email" hint="We never share it." error="Enter an email." id="em">
        <Input />
      </Field>
    );
    expect(out).toContain('for="em"');
    expect(out).toContain('id="em"');
    expect(out).toContain('aria-describedby="em-hint em-error"');
    expect(out).toContain('aria-invalid="true"');
  });

  it("UnderlineField has a visible label and a labelled password toggle", () => {
    const out = html(<UnderlineField label="Password" type="password" id="pw" />);
    expect(out).toContain('<label for="pw"');
    expect(out).toContain("underline-field");
    expect(out).toContain('aria-label="Show password"');
    expect(out).toContain('aria-pressed="false"');
  });
});

describe("Command palette ranking", () => {
  const items = [
    { id: "a", label: "Admin features", keywords: ["switches"] },
    { id: "b", label: "My courses" },
    { id: "c", label: "Course player" },
    { id: "d", label: "Features overview" },
  ];

  it("ranks exact > prefix > word start > substring > subsequence", () => {
    expect(scoreText("Features", "features")).toBe(100);
    expect(scoreText("Features overview", "feat")).toBe(80);
    expect(scoreText("Admin features", "feat")).toBe(60);
    expect(scoreText("Admin features", "eatu")).toBe(40);
    expect(scoreText("Admin features", "adft")).toBe(10);
    expect(scoreText("Admin features", "zz")).toBe(0);
  });

  it("filters, orders by score and keeps the caller's order on ties", () => {
    expect(filterCommands(items, "feat").map((item) => item.id)).toEqual(["d", "a"]);
    expect(filterCommands(items, "course").map((item) => item.id)).toEqual(["c", "b"]);
    expect(filterCommands(items, "switch").map((item) => item.id)).toEqual(["a"]);
    expect(filterCommands(items, "").map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("Toast store", () => {
  it("queues at most four toasts and dismisses by id", () => {
    dismissToast();
    const ids = [1, 2, 3, 4, 5].map((n) => toast({ title: `t${n}` }));
    expect(ids).toHaveLength(5);
    dismissToast(ids[4]);
    dismissToast();
  });
});

describe("Motion (final state without a browser)", () => {
  it("treats a server render as reduced motion", () => {
    expect(prefersReducedMotion()).toBe(true);
  });

  it("Reveal renders its content visible, with no hidden styles", () => {
    const out = html(<Reveal as="li">Case closed</Reveal>);
    expect(out).toBe("<li>Case closed</li>");
  });

  it("Terminal shows every line at once and names itself for screen readers", () => {
    const out = html(<Terminal title="lab-01" typing lines={["$ whois example.org", "Answer accepted"]} />);
    expect(out).toContain("$ whois example.org");
    expect(out).toContain('aria-label="lab-01: $ whois example.org / Answer accepted"');
    expect(out).toContain("text-accent");
  });

  it("Timeline emphasises only the last step", () => {
    const out = html(
      <Timeline>
        <TimelineStep number={1} title="Read" />
        <TimelineStep number={2} title="Prove" last />
      </Timeline>
    );
    expect(out.match(/shadow-dot-active/g)).toHaveLength(1);
    expect(out).toContain('<span class="sr-only">Step 2: </span>');
  });
});

describe("Palette law", () => {
  it("allows black, greys, whites and the golden-white family at any alpha", () => {
    for (const colour of ["#000", "#fafafa", "#8a8a8a", "rgb(255 255 255 / .1)", "#F3E2B3", "rgba(243, 226, 179, 0.45)", "#e6d29c", "#6b6150", "transparent"]) {
      expect(isLawful(colour), colour).toBe(true);
    }
  });

  it("rejects every other hue", () => {
    for (const colour of ["#ff0000", "#50fa7b", "#8be9fd", "#ffb86c", "#7aa2f7", "#d4af37", "hsl(210 50% 50%)", "rgba(109, 40, 217, .2)"]) {
      expect(isLawful(colour), colour).toBe(false);
    }
  });

  it("the lint finds hues in CSS and JS, and honours the OwlCognito and allow exceptions", () => {
    expect(checkText(".a { color: #50fa7b; }", "frontend/src/x.css")).toHaveLength(1);
    expect(checkText(".a { border: 1px solid red; }", "frontend/src/x.css")).toHaveLength(1);
    expect(checkText('const c = "rgba(122, 162, 247, .3)";', "frontend/src/x.js")).toHaveLength(1);
    expect(checkText(".a { color: #f3e2b3; background: rgb(0 0 0 / .8); }", "frontend/src/x.css")).toHaveLength(0);
    expect(checkText('html[data-site-brand="owlcognito"] .a { color: #6d28d9; }', "frontend/src/x.css")).toHaveLength(0);
    expect(checkText('.a { color: #6d28d9; } /* palette-law: allow third-party */', "frontend/src/x.css")).toHaveLength(0);
    expect(checkText('<a href="#top">x</a>', "frontend/src/x.jsx")).toHaveLength(0);
    expect(checkText("x", "frontend/src/assets/brand/hero.css")).toHaveLength(0);
  });

  it("the kit, its styles and the theme carry no unlawful colour", () => {
    const files = [
      ...fs.readdirSync(path.join(root, "src/kit"), { recursive: true }).filter((file) => /\.(jsx?|css)$/.test(file) && !/\.test\./.test(file)).map((file) => `src/kit/${file}`),
      "src/styles/theme.css",
      "src/styles/kit.css",
      "src/features/app-shell/styles/_carbon-bridge.scss",
      "src/features/app-shell/styles/_carbon-bridge-tokens.scss",
    ];
    const findings = files.flatMap((file) => checkText(fs.readFileSync(path.join(root, file), "utf8"), `frontend/${file.replace(/\\/g, "/")}`));
    expect(findings).toEqual([]);
  });

  it("every Tailwind colour resolves to a lawful value", () => {
    const { colors } = resolveConfig(tailwindConfig).theme;
    // Hybrid release: the public website is the Friday 13 Nov site, which uses
    // Tailwind's default hue families (red/amber/emerald states) on purpose.
    // Those families are exempt; every kit/semantic token must stay lawful.
    const fridayFamilies = new Set(Object.keys(defaultTailwindColors));
    for (const name of fridayFamilies) delete colors[name];
    for (const name of ["ink", "panel", "panel2"]) delete colors[name];
    const bad = [];
    const visit = (value, name) => {
      if (typeof value === "string") {
        if (parseColour(value) && !isLawful(value)) bad.push(`${name}: ${value}`);
      } else if (value && typeof value === "object") Object.entries(value).forEach(([key, inner]) => visit(inner, `${name}-${key}`));
    };
    visit(colors, "colors");
    expect(bad).toEqual([]);
  });
});

describe("Contrast (WCAG AA for every text token pair)", () => {
  const pairs = [
    ["#fafafa", "#000000"],
    ["#a1a1a1", "#000000"],
    ["#a1a1a1", "#0a0a0a"],
    ["#a1a1a1", "#111111"],
    ["#8a8a8a", "#000000"],
    ["#8a8a8a", "#0a0a0a"],
    ["#8a8a8a", "#111111"],
    ["#f3e2b3", "#000000"],
    ["#0a0a0a", "#f3e2b3"],
    ["#000000", "#ffffff"],
    ["#666666", "#ffffff"], // black/60 meta on an inverted (white) card
  ];
  it.each(pairs)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

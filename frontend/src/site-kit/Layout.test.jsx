import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { act, renderTree } from "../test-utils/renderTree";
import Band, { Column } from "./Band";
import DataStat from "./DataStat";
import ProgressIndicator from "./ProgressIndicator";
import Reveal, { useReveal } from "./Reveal";
import Skeleton from "./Skeleton";

describe("site kit Band and grid", () => {
  it("is a themed full-bleed section with the 2x grid inside", () => {
    expect(renderToStaticMarkup(<Band theme="g100" id="watch" labelledBy="watch-heading">x</Band>)).toBe(
      '<section data-theme="g100" aria-labelledby="watch-heading" class="sk-band" id="watch"><div class="sk-band__inner sk-grid">x</div></section>'
    );
    expect(renderToStaticMarkup(<Band theme="purple">x</Band>)).toContain('data-theme="white"');
  });

  it("spans columns per breakpoint through CSS variables", () => {
    expect(renderToStaticMarkup(<Column sm={4} md={4} lg={8}>x</Column>)).toBe(
      '<div class="sk-col" style="--sk-span-sm:4;--sk-span-md:4;--sk-span-lg:8">x</div>'
    );
    expect(renderToStaticMarkup(<Column lg={6} start={11}>x</Column>)).toContain("--sk-start-lg:11");
    expect(renderToStaticMarkup(<Column sm={9} lg={40}>x</Column>)).toContain("--sk-span-sm:4;--sk-span-md:8;--sk-span-lg:16");
  });
});

describe("site kit DataStat", () => {
  it("is a description list with the label first in the DOM", () => {
    expect(renderToStaticMarkup(<DataStat items={[{ value: "1000+", label: "Students trained" }]} />)).toBe(
      '<dl class="sk-datastat"><div class="sk-datastat__item"><dt class="sk-datastat__label">Students trained</dt><dd class="sk-datastat__value">1000+</dd></div></dl>'
    );
  });

  it("renders nothing for zero items", () => {
    expect(renderToStaticMarkup(<DataStat items={[]} />)).toBe("");
    expect(renderToStaticMarkup(<DataStat items={null} />)).toBe("");
  });
});

describe("site kit ProgressIndicator", () => {
  const steps = [{ title: "Enroll in the flagship course" }, { title: "Learn the recon workflow" }, { title: "Apply web app pentesting" }];

  it("is an ordered list with the current step marked for assistive tech", () => {
    const markup = renderToStaticMarkup(<ProgressIndicator steps={steps} currentIndex={1} label="How your journey works" />);
    expect(markup).toMatch(/^<ol class="sk-progress" aria-label="How your journey works">/);
    expect(markup.match(/<li /g)).toHaveLength(3);
    expect(markup).toContain('class="sk-progress__step sk-progress__step--complete"');
    expect(markup).toContain('class="sk-progress__step sk-progress__step--current" aria-current="step"');
    expect(markup).toContain(" (current step)");
  });

  it("can be forced vertical, honours explicit statuses and renders nothing without steps", () => {
    const markup = renderToStaticMarkup(<ProgressIndicator vertical steps={[{ title: "Done", status: "complete" }]} />);
    expect(markup).toContain('class="sk-progress sk-progress--vertical"');
    expect(markup).toContain(" (complete)");
    expect(renderToStaticMarkup(<ProgressIndicator steps={[]} />)).toBe("");
  });
});

describe("site kit Skeleton", () => {
  afterEach(() => vi.useRealTimers());

  it("stays hidden for 300 ms so fast responses never flash, then shows a busy status", async () => {
    vi.useFakeTimers();
    const tree = await renderTree(<Skeleton lines={2} label="Loading courses" />);
    expect(tree.all(() => true)).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(tree.all(() => true)).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const status = tree.find((node) => node.props.role === "status");
    expect(status.props["aria-busy"]).toBe("true");
    expect(status.props["aria-label"]).toBe("Loading courses");
    expect(tree.all((node) => node.props.className === "sk-skeleton__bar")).toHaveLength(2);
    await tree.unmount();
  });

  it("renders immediately with delay 0 and a single block variant", () => {
    const markup = renderToStaticMarkup(<Skeleton delay={0} variant="block" height="12rem" />);
    expect(markup).toContain('class="sk-skeleton sk-skeleton--block"');
    expect(markup.match(/sk-skeleton__bar/g)).toHaveLength(1);
    expect(markup).toContain("height:12rem");
  });
});

describe("site kit Reveal (motion)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is visible by default: nothing hidden without IntersectionObserver", async () => {
    const tree = await renderTree(<Reveal>Content</Reveal>);
    expect(tree.find((node) => node.type === "div").props["data-reveal"]).toBeUndefined();
    await tree.unmount();
  });

  it("animates below-the-fold content once when it enters the viewport", async () => {
    const observers = [];
    vi.stubGlobal("window", { innerHeight: 800, matchMedia: () => ({ matches: false }) });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback) {
          this.callback = callback;
          this.disconnected = false;
          observers.push(this);
        }
        observe() {}
        disconnect() {
          this.disconnected = true;
        }
      }
    );
    // Already on screen at mount (the host stub reports top 0): never hidden.
    const tree = await renderTree(<Reveal>Content</Reveal>);
    expect(tree.find((node) => node.type === "div").props["data-reveal"]).toBeUndefined();
    await tree.unmount();

    // Below the fold: the ref callback places the element before the effect measures it.
    function Probe() {
      const reveal = useReveal();
      const { ref } = reveal;
      return (
        <div
          ref={(node) => {
            if (node) node.getBoundingClientRect = () => ({ top: 2000 });
            ref.current = node;
          }}
          data-reveal={reveal["data-reveal"]}
        />
      );
    }
    const probe = await renderTree(<Probe />);
    const node = () => probe.find((item) => item.type === "div");
    expect(node().props["data-reveal"]).toBe("pending");
    await act(async () => observers.at(-1).callback([{ isIntersecting: true }]));
    expect(node().props["data-reveal"]).toBe("in");
    expect(observers.at(-1).disconnected).toBe(true);
    await probe.unmount();
  });

  it("never hides content under reduced motion", async () => {
    vi.stubGlobal("window", { innerHeight: 800, matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    const tree = await renderTree(<Reveal>Content</Reveal>);
    expect(tree.find((node) => node.type === "div").props["data-reveal"]).toBeUndefined();
    await tree.unmount();
  });
});

// Motion kit (UI overhaul §2.2-§2.4, WS-A acceptance): final values under
// reduced motion, nothing running in hidden tabs, loops that stop.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderTree } from "../../test-utils/renderTree";
import { CountUp, LiveDot, Meter, RollingDigits } from "./components";
import { navigateWithTransition, resetCountUpMemory, setMotionPreference, useCountUp, useFlip, useInViewOnce, useStagger } from "./hooks";

const here = path.dirname(fileURLToPath(import.meta.url));
const motionCss = fs.readFileSync(path.join(here, "motion.css"), "utf8");

/** A small browser: matchMedia, a document with visibility, a manual rAF queue. */
function fakeBrowser({ reduced = false } = {}) {
  const listeners = {};
  const frames = [];
  const doc = {
    hidden: false,
    documentElement: { dataset: {} },
    addEventListener: (name, fn) => (listeners[name] ||= new Set()).add(fn),
    removeEventListener: (name, fn) => listeners[name]?.delete(fn),
    dispatch(name) {
      [...(listeners[name] || [])].forEach((fn) => fn({ type: name }));
    },
    listenerCount: (name) => listeners[name]?.size || 0,
  };
  const storage = new Map();
  const store = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
    sessionStorage: store,
    localStorage: store,
  });
  vi.stubGlobal("requestAnimationFrame", (fn) => frames.push(fn));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    doc,
    storage,
    /** Runs queued frames at `time` ms. */
    async frame(time) {
      const queued = frames.splice(0);
      await act(() => queued.forEach((fn) => fn(time)));
    },
  };
}

function CountProbe({ value, start = true, sessionKey }) {
  const shown = useCountUp(value, { start, sessionKey });
  return <output>{String(shown)}</output>;
}

beforeEach(() => resetCountUpMemory());
afterEach(() => vi.unstubAllGlobals());

describe("useCountUp (M5)", () => {
  it("counts from 0 to the value over 700 ms with rAF", async () => {
    const browser = fakeBrowser();
    const tree = await renderTree(<CountProbe value={40} />);
    expect(tree.text()).toBe("0");
    await browser.frame(0);
    await browser.frame(350);
    const middle = Number(tree.text());
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(40);
    await browser.frame(700);
    expect(tree.text()).toBe("40");
    await tree.unmount();
  });

  it("shows the final value at once under reduced motion (OS or Profile toggle)", async () => {
    fakeBrowser({ reduced: true });
    const tree = await renderTree(<CountProbe value={12} />);
    expect(tree.text()).toBe("12");
    await tree.unmount();

    const browser = fakeBrowser();
    setMotionPreference("reduce");
    expect(browser.doc.documentElement.dataset.motion).toBe("reduce");
    const again = await renderTree(<CountProbe value={7} />);
    expect(again.text()).toBe("7");
    await again.unmount();
  });

  it("aborts to the final value when the tab is hidden", async () => {
    const browser = fakeBrowser();
    const tree = await renderTree(<CountProbe value={90} />);
    await browser.frame(0);
    await browser.frame(100);
    expect(tree.text()).not.toBe("90");
    browser.doc.hidden = true;
    await act(() => browser.doc.dispatch("visibilitychange"));
    expect(tree.text()).toBe("90");
    expect(browser.doc.listenerCount("visibilitychange")).toBe(0);
    await tree.unmount();
  });

  it("runs once per session key (owner decision D6)", async () => {
    const browser = fakeBrowser();
    const first = await renderTree(<CountProbe value={5} sessionKey="admin:requests" />);
    await browser.frame(0);
    await browser.frame(700);
    await first.unmount();
    const second = await renderTree(<CountProbe value={5} sessionKey="admin:requests" />);
    expect(second.text()).toBe("5");
    await second.unmount();
  });

  it("waits for `start` (first view) and passes non-numbers through", async () => {
    fakeBrowser();
    const tree = await renderTree(<CountProbe value={3} start={false} />);
    expect(tree.text()).toBe("0");
    await tree.rerender(<CountProbe value="—" start />);
    expect(tree.text()).toBe("—");
    await tree.unmount();
  });
});

describe("useInViewOnce", () => {
  it("flips to seen once and disconnects", async () => {
    fakeBrowser();
    const observers = [];
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
    function Probe() {
      const [ref, seen] = useInViewOnce();
      return <div ref={ref}>{seen ? "seen" : "waiting"}</div>;
    }
    const tree = await renderTree(<Probe />);
    expect(tree.text()).toBe("waiting");
    await act(() => observers[0].callback([{ isIntersecting: true }]));
    expect(tree.text()).toBe("seen");
    expect(observers[0].disconnected).toBe(true);
    await tree.unmount();
  });
});

describe("useFlip", () => {
  it("slides moved items from their old place with a transform, and does nothing under reduced motion", async () => {
    fakeBrowser();
    const animate = vi.fn();
    let top = 0;
    const node = { dataset: { flipKey: "a" }, animate, getBoundingClientRect: () => ({ left: 0, top }) };
    const root = { querySelectorAll: () => [node] };
    let api;
    function Probe({ tick }) {
      api = useFlip();
      api.ref.current = root;
      return <span>{tick}</span>;
    }
    const tree = await renderTree(<Probe tick={0} />);
    api.capture();
    top = 40;
    await tree.rerender(<Probe tick={1} />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0][0]).toEqual({ transform: "translate(0px, -40px)" });

    setMotionPreference("reduce");
    api.capture();
    top = 80;
    await tree.rerender(<Probe tick={2} />);
    expect(animate).toHaveBeenCalledTimes(1);
    await tree.unmount();
  });
});

describe("navigateWithTransition (M1)", () => {
  it("falls back to plain navigation without the View Transitions API", () => {
    fakeBrowser();
    const navigate = vi.fn();
    navigateWithTransition(navigate, "/console", { replace: true });
    expect(navigate).toHaveBeenCalledWith("/console", { replace: true });
  });

  it("wraps navigation in document.startViewTransition when available", () => {
    const browser = fakeBrowser();
    browser.doc.startViewTransition = vi.fn((update) => update());
    const navigate = vi.fn();
    navigateWithTransition(navigate, "/my-courses");
    expect(browser.doc.startViewTransition).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/my-courses", {});
  });
});

describe("useStagger (M2)", () => {
  it("indexes items on the first data render only", async () => {
    vi.useFakeTimers();
    let enter;
    function Probe({ ready }) {
      enter = useStagger(ready);
      return null;
    }
    const tree = await renderTree(<Probe ready={false} />);
    await tree.rerender(<Probe ready />);
    expect(enter(3).style["--sc-i"]).toBe(3);
    expect(enter(3)["data-sc-enter"]).toBe("");
    await act(() => vi.advanceTimersByTime(700));
    expect(enter(3).style["--sc-i"]).toBe(0);
    vi.useRealTimers();
    await tree.unmount();
  });
});

describe("LiveDot (M8)", () => {
  it("pings 3 times then rests, with a static ring and no loop under reduced motion", () => {
    expect(motionCss).toMatch(/\.sc-live-dot::after \{[^}]*animation: sc-ping var\(--sc-live-period\) [^;]* 3;/);
    expect(motionCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+\.sc-live-dot::after,/);
    expect(motionCss).toMatch(/:root\[data-motion="reduce"\] \.sc-live-dot::after/);
    expect(motionCss).toMatch(/\.sc-live-dot--reconnecting::after \{\s+animation: none;/);
  });

  it("restarts the ping when the tab becomes visible and announces itself only with a label", async () => {
    const browser = fakeBrowser();
    const tree = await renderTree(<LiveDot state="live" label="Live now" />);
    const before = tree.find((node) => node.type === "span");
    expect(before.props["aria-label"]).toBe("Live now");
    await act(() => browser.doc.dispatch("visibilitychange"));
    const after = tree.find((node) => node.type === "span");
    expect(after).not.toBe(before);
    await tree.rerender(<LiveDot state="reconnecting" />);
    const dot = tree.find((node) => node.type === "span");
    expect(dot.props.className).toContain("sc-live-dot--reconnecting");
    expect(dot.props["aria-hidden"]).toBe("true");
    await tree.unmount();
  });
});

describe("RollingDigits (M9)", () => {
  it("rolls only the changed digit and swaps under reduced motion", async () => {
    fakeBrowser();
    const tree = await renderTree(<RollingDigits value="04:28" />);
    expect(tree.all((node) => String(node.props.className).includes("--in"))).toHaveLength(0);
    await tree.rerender(<RollingDigits value="04:27" />);
    const rolling = tree.all((node) => String(node.props.className).includes("--in"));
    expect(rolling).toHaveLength(1);
    expect(rolling[0].children[0].text).toBe("7");
    expect(tree.all((node) => String(node.props.className).includes("--out"))[0].children[0].text).toBe("8");
    await tree.unmount();

    fakeBrowser({ reduced: true });
    const still = await renderTree(<RollingDigits value="10" />);
    await still.rerender(<RollingDigits value="11" />);
    expect(still.all((node) => String(node.props.className).includes("--in"))).toHaveLength(0);
    await still.unmount();
  });
});

describe("Meter (M6) and CountUp", () => {
  it("fills with transform: scaleX, never width, and turns green when complete", async () => {
    fakeBrowser();
    const tree = await renderTree(<Meter value={0.4} label="Course progress" />);
    const fill = tree.find((node) => node.props.className === "sc-meter__fill");
    expect(fill.props.style.transform).toBe("scaleX(0.4)");
    expect(fill.props.style.width).toBeUndefined();
    await tree.rerender(<Meter value={1} label="Course progress" />);
    expect(tree.find((node) => node.props.role === "progressbar").props.className).toContain("sc-meter--done");
    await tree.unmount();
    expect(motionCss).toMatch(/\.sc-meter__fill \{[^}]*transition: transform var\(--sc-duration-slow-01\)/);
  });

  it("CountUp keeps the real value for screen readers and reserves its width", async () => {
    fakeBrowser({ reduced: true });
    const tree = await renderTree(<CountUp value={1200} />);
    const host = tree.find((node) => String(node.props.className).includes("sc-count-up"));
    expect(host.props.style.minInlineSize).toBe(`${(1200).toLocaleString().length}ch`);
    expect(tree.text()).toBe((1200).toLocaleString());
    await tree.unmount();
  });
});

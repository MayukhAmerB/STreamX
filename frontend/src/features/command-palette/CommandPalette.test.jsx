// WS-G: Ctrl/Cmd+K palette behaviour (plan §4.5, §7.5 unit list):
// keyboard (arrows, Enter, Esc), focus return, staff-only records, the
// singleton mount, and the pure model (matching, highlight, recents).
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthContext } from "../../context/AuthContext";
import { act, fire, renderTree, textOf } from "../../test-utils/renderTree";
import CommandPalette, { isPaletteShortcut, SEARCH_DEBOUNCE_MS } from "./CommandPalette";
import { openCommandPalette } from "./events";
import { buildDestinations, buildGroups, buildTasks, highlightParts, matchScore, readRecent, recordGroups, rememberRecent } from "./paletteModel";

const get = vi.fn();
vi.mock("../../api/client", () => ({ default: { get: (...args) => get(...args) } }));

class KeyEvent extends Event {
  constructor(type, init = {}) {
    super(type, { cancelable: true });
    Object.assign(this, { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
  }
}

function fakeBrowser() {
  const win = new EventTarget();
  Object.assign(win, {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    location: { assign: vi.fn() },
    open: vi.fn(),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const trigger = { isConnected: true, focused: false, focus() { this.focused = true; } };
  const doc = { activeElement: trigger, body: {}, hidden: false, addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } };
  const store = new Map();
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("localStorage", {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  });
  return { win, doc, trigger, store };
}

const staff = { user: { id: 3, full_name: "Ayesha Admin", is_admin: true, role: "student" }, isAdmin: true, isInstructor: false, isAuthenticated: true };
const student = { user: { id: 1, full_name: "Sana Student", is_admin: false, role: "student" }, isAdmin: false, isInstructor: false, isAuthenticated: true };

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

async function mount(auth) {
  const tree = await renderTree(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={["/console/admin"]}>
        <CommandPalette />
        <CommandPalette />
        <Where />
      </MemoryRouter>
    </AuthContext.Provider>
  );
  const input = () => tree.find((node) => node.type === "input" && node.props.role === "combobox");
  const where = () => textOf(tree.find((node) => node.props?.["data-testid"] === "where"));
  return { tree, input, where };
}

const pressKey = (target, key, init = {}) => act(() => target.dispatchEvent(new KeyEvent("keydown", { key, ...init })));
const typeKey = (input, key) => fire(input, "onKeyDown", { key });

describe("CommandPalette", () => {
  let browser;
  beforeEach(() => {
    browser = fakeBrowser();
    get.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("opens with Ctrl+K (one dialog even when mounted twice) and is a combobox", async () => {
    const { tree, input } = await mount(staff);
    expect(input()).toBeNull();
    await pressKey(browser.win, "k", { ctrlKey: true });
    expect(tree.all((node) => node.props?.role === "dialog")).toHaveLength(1);
    const field = input();
    expect(field.props["aria-expanded"]).toBe(true);
    expect(field.props["aria-controls"]).toBe(tree.find((node) => node.props?.role === "listbox").props.id);
    expect(field.focused).toBe(true);
    expect(textOf(tree.find((node) => node.props?.role === "listbox"))).toContain("Tasks");
    await tree.unmount();
  });

  it("moves with the arrows, opens with Enter and keeps the active option announced", async () => {
    const { tree, input, where } = await mount(staff);
    await act(() => openCommandPalette({ initialQuery: "requests" }));
    const options = () => tree.all((node) => node.props?.role === "option");
    expect(input().props["aria-activedescendant"]).toBe(options()[0].props.id);
    await typeKey(input(), "ArrowDown");
    expect(input().props["aria-activedescendant"]).toBe(options()[1].props.id);
    expect(options()[1].props["aria-selected"]).toBe(true);
    await typeKey(input(), "ArrowUp");
    await typeKey(input(), "ArrowUp"); // wraps to the last option
    expect(input().props["aria-activedescendant"]).toBe(options()[options().length - 1].props.id);
    await typeKey(input(), "Home");
    expect(textOf(options()[0])).toContain("Review requests");
    await typeKey(input(), "Enter");
    expect(input()).toBeNull();
    expect(where()).toBe("/console/admin/requests");
    expect(readRecent(3)[0].href).toBe("/console/admin/requests");
    await tree.unmount();
  });

  it("Esc closes and returns focus to what opened it", async () => {
    const { tree, input } = await mount(staff);
    await pressKey(browser.win, "k", { metaKey: true });
    expect(input()).not.toBeNull();
    await typeKey(input(), "Escape");
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(input()).toBeNull();
    expect(browser.trigger.focused).toBe(true);
    await tree.unmount();
  });

  it("searches records for staff after the debounce and opens back-office hits as a page load", async () => {
    vi.useFakeTimers();
    get.mockResolvedValue({
      data: { data: { q: "pay", groups: [{ key: "payments", label: "Payments", items: [{ id: "pay_9", title: "Order ORD-1042", subtitle: "sana@example.com", href: "/admin/payments/payment/9/change/" }] }] } },
    });
    const { tree, input } = await mount(staff);
    await act(() => openCommandPalette());
    await fire(input(), "onChange", { target: { value: "pay" } });
    expect(get).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(get).toHaveBeenCalledWith("/admin/search/", { params: { q: "pay" } });
    await act(async () => {
      await Promise.resolve();
    });
    const listbox = tree.find((node) => node.props?.role === "listbox");
    expect(textOf(listbox)).toContain("Payments");
    const option = tree.find((node) => node.props?.role === "option" && textOf(node).includes("Order ORD-1042"));
    // The matched text is the 600-weight highlight, not a colour.
    expect(tree.find((node) => node.type === "strong" && textOf(node).toLowerCase() === "pay")).not.toBeNull();
    await fire(option, "onClick");
    expect(browser.win.location.assign).toHaveBeenCalledWith("/admin/payments/payment/9/change/");
    await tree.unmount();
  });

  it("gives students destinations only: no tasks, no record search", async () => {
    vi.useFakeTimers();
    const { tree, input } = await mount(student);
    await act(() => openCommandPalette());
    expect(input().props.placeholder).toBe("Jump to a page");
    const text = textOf(tree.find((node) => node.props?.role === "listbox"));
    expect(text).not.toContain("Tasks");
    expect(text).toContain("Go to");
    await fire(input(), "onChange", { target: { value: "courses" } });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(get).not.toHaveBeenCalled();
    expect(tree.all((node) => node.props?.role === "option").length).toBeGreaterThan(0);
    await tree.unmount();
  });

  it("does nothing for signed-out visitors", async () => {
    const { tree, input } = await mount({ user: null, isAdmin: false });
    await pressKey(browser.win, "k", { ctrlKey: true });
    expect(input()).toBeNull();
    await tree.unmount();
  });
});

describe("palette model", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognises the shortcut", () => {
    expect(isPaletteShortcut({ key: "k", ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: "K", metaKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: "k" })).toBe(false);
    expect(isPaletteShortcut({ key: "k", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it("scores title prefixes above keyword matches and drops non-matches", () => {
    const item = { title: "Turn features on or off", keywords: ["teachers"] };
    expect(matchScore(item, "turn")).toBeGreaterThan(matchScore(item, "teachers"));
    expect(matchScore(item, "teachers")).toBeGreaterThan(0);
    expect(matchScore(item, "payments")).toBe(0);
  });

  it("highlights the matched substring", () => {
    expect(highlightParts("Payal Sharma", "pay")).toEqual([
      { text: "Pay", match: true },
      { text: "al Sharma", match: false },
    ]);
    expect(highlightParts("Order", "zzz")).toEqual([{ text: "Order", match: false }]);
  });

  it("builds groups in Task / Record / Section order", () => {
    const groups = buildGroups({
      query: "pay",
      tasks: buildTasks({ isAdmin: true }),
      destinations: buildDestinations({ isAdmin: true, user: { is_admin: true } }),
      records: recordGroups({ groups: [{ key: "people", label: "People", items: [{ id: "user_1", title: "Payal", href: "/admin/users/user/1/change/" }] }] }),
    });
    expect(groups.map((group) => group.label)).toEqual(["Tasks", "People", "Sections"]);
    expect(buildTasks({ isAdmin: false })).toEqual([]);
  });

  it("keeps recents optional: storage that throws is ignored", () => {
    const broken = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(readRecent(1, broken)).toEqual([]);
    expect(rememberRecent(1, { kind: "section", title: "Requests", href: "/console/admin/requests" }, broken)).toHaveLength(1);
  });
});

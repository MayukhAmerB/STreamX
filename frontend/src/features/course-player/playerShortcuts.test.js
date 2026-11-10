import { describe, expect, it } from "vitest";
import { resolvePlayerShortcut } from "./playerShortcuts";

const element = (tagName, attributes = {}) => ({
  tagName,
  isContentEditable: false,
  getAttribute: (name) => attributes[name] ?? null,
});
const key = (keyName, options = {}) => ({ key: keyName, target: element("BODY"), ...options });

describe("resolvePlayerShortcut", () => {
  it("maps the standard YouTube keys", () => {
    expect(resolvePlayerShortcut(key("k"))).toEqual({ action: "toggle-play" });
    expect(resolvePlayerShortcut(key(" "))).toEqual({ action: "toggle-play" });
    expect(resolvePlayerShortcut(key("j"))).toEqual({ action: "seek", seconds: -10 });
    expect(resolvePlayerShortcut(key("l"))).toEqual({ action: "seek", seconds: 10 });
    expect(resolvePlayerShortcut(key("ArrowLeft"))).toEqual({ action: "seek", seconds: -5 });
    expect(resolvePlayerShortcut(key("ArrowRight"))).toEqual({ action: "seek", seconds: 5 });
    expect(resolvePlayerShortcut(key("m"))).toEqual({ action: "mute" });
    expect(resolvePlayerShortcut(key("f"))).toEqual({ action: "fullscreen" });
    expect(resolvePlayerShortcut(key("N", { shiftKey: true }))).toEqual({ action: "next" });
    expect(resolvePlayerShortcut(key("P", { shiftKey: true }))).toEqual({ action: "previous" });
  });

  it("never fires while typing", () => {
    expect(resolvePlayerShortcut(key("k", { target: element("TEXTAREA") }))).toBeNull();
    expect(resolvePlayerShortcut(key("k", { target: element("INPUT") }))).toBeNull();
    expect(resolvePlayerShortcut(key("k", { target: { ...element("DIV"), isContentEditable: true } }))).toBeNull();
    expect(resolvePlayerShortcut(key("k", { isComposing: true }))).toBeNull();
  });

  it("leaves keys to focused widgets and browser shortcuts", () => {
    expect(resolvePlayerShortcut(key(" ", { target: element("BUTTON") }))).toBeNull();
    expect(resolvePlayerShortcut(key("ArrowRight", { target: element("BUTTON", { role: "tab" }) }))).toBeNull();
    expect(resolvePlayerShortcut(key("k", { ctrlKey: true }))).toBeNull();
    expect(resolvePlayerShortcut(key("l", { metaKey: true }))).toBeNull();
    expect(resolvePlayerShortcut(key("k", { defaultPrevented: true }))).toBeNull();
    expect(resolvePlayerShortcut(key("x"))).toBeNull();
    expect(resolvePlayerShortcut(key("K", { shiftKey: true }))).toBeNull();
  });
});

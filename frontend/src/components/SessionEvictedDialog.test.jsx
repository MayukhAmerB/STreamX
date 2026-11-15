import { Children, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { isSessionEviction, loginReturnState } from "../utils/sessionEviction";
import Button from "./Button";
import SessionEvictedDialog from "./SessionEvictedDialog";

function findButtons(node, found = []) {
  if (!isValidElement(node)) {
    return found;
  }
  if (node.type === Button) {
    found.push(node);
  }
  Children.forEach(node.props.children, (child) => findButtons(child, found));
  return found;
}

function buttonsOf(props) {
  const buttons = findButtons(SessionEvictedDialog({ open: true, ...props }));
  return Object.fromEntries(buttons.map((button) => [button.props.children, button]));
}

describe("SessionEvictedDialog", () => {
  it("renders nothing while the session is active", () => {
    expect(renderToStaticMarkup(<SessionEvictedDialog open={false} />)).toBe("");
  });

  it("explains the eviction in an accessible modal with both choices", () => {
    const html = renderToStaticMarkup(<SessionEvictedDialog open onUseThisDevice={() => {}} onSignOut={() => {}} />);

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="session-evicted-title"');
    expect(html).toContain("You signed in on another device");
    expect(html).toContain("Use this device");
    expect(html).toContain("Sign out");
  });

  it("wires the primary button to re-sign-in and the secondary one to sign out", () => {
    const onUseThisDevice = vi.fn();
    const onSignOut = vi.fn();
    const buttons = buttonsOf({ onUseThisDevice, onSignOut });

    expect(Object.keys(buttons)).toEqual(["Use this device", "Sign out"]);
    expect(buttons["Use this device"].props.variant).toBeUndefined();
    expect(buttons["Use this device"].props.autoFocus).toBe(true);
    expect(buttons["Sign out"].props.variant).toBe("secondary");

    buttons["Use this device"].props.onClick();
    expect(onUseThisDevice).toHaveBeenCalledTimes(1);
    expect(onSignOut).not.toHaveBeenCalled();

    buttons["Sign out"].props.onClick();
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("locks both choices while signing out", () => {
    const buttons = buttonsOf({ signingOut: true, onUseThisDevice: () => {}, onSignOut: () => {} });

    expect(buttons["Use this device"].props.disabled).toBe(true);
    expect(buttons["Sign out"].props.loading).toBe(true);
  });
});

describe("session eviction helpers", () => {
  it("recognises only the session_replaced rejection as an eviction", () => {
    expect(isSessionEviction({ code: "session_replaced" })).toBe(true);
    expect(isSessionEviction({ code: "refresh_token_revoked" })).toBe(false);
    expect(isSessionEviction({ code: "refresh_token_invalid" })).toBe(false);
    expect(isSessionEviction(undefined)).toBe(false);
  });

  it("returns the student to the exact page after signing in again", () => {
    expect(loginReturnState({ pathname: "/learn/29", search: "?lecture=4", hash: "#notes" })).toEqual({
      from: "/learn/29?lecture=4#notes",
    });
    expect(loginReturnState({ pathname: "/courses/7/live", search: "", hash: "" })).toEqual({
      from: "/courses/7/live",
    });
    expect(loginReturnState({ pathname: "/login", search: "", hash: "" })).toEqual({ from: "/" });
  });
});

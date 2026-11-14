// Phase 2 live-class resilience: meeting rejoin policy, stable device id,
// the "class is playing" guard and the eviction banner.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionEvictionPrompt } from "../../context/AuthContext";
import LiveEvictionBanner from "../../components/realtime/LiveEvictionBanner";
import { DEVICE_ID_STORAGE_KEY, getRealtimeDeviceId, isValidDeviceId } from "./deviceId";
import {
  isLiveClassActive,
  registerLiveClassPlayback,
  resetLiveClassGuard,
  subscribeLiveClassGuard,
} from "./liveClassGuard";
import {
  MEETING_REJOIN_MAX_DELAY_MS,
  canRetryMeetingNow,
  isTerminalRejoinError,
  meetingRejoinDelay,
} from "./meetingReconnect";

function storage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => {
      values[key] = String(value);
    },
  };
}

function httpError(status, data = {}) {
  return { response: { status, data } };
}

describe("meeting rejoin policy", () => {
  it("never gives up: quick first attempts, then capped at 30 s", () => {
    expect(meetingRejoinDelay(0, () => 0.5)).toBe(0);
    expect(meetingRejoinDelay(1, () => 0.5)).toBe(1500);
    for (let attempt = 3; attempt < 200; attempt += 1) {
      const delay = meetingRejoinDelay(attempt, Math.random);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(MEETING_REJOIN_MAX_DELAY_MS);
    }
    expect(meetingRejoinDelay(50, () => 1)).toBe(MEETING_REJOIN_MAX_DELAY_MS);
  });

  it("spreads a class's reconnects with jitter (never zero once backing off)", () => {
    const low = meetingRejoinDelay(10, () => 0);
    const high = meetingRejoinDelay(10, () => 1);
    expect(low).toBe(MEETING_REJOIN_MAX_DELAY_MS / 2);
    expect(high).toBe(MEETING_REJOIN_MAX_DELAY_MS);
  });

  it("stops only on errors a retry cannot fix", () => {
    expect(isTerminalRejoinError(httpError(400, { message: "Session has ended." }))).toBe(true);
    expect(isTerminalRejoinError(httpError(403, {}))).toBe(true);
    expect(isTerminalRejoinError(httpError(404, {}))).toBe(true);
    expect(isTerminalRejoinError(httpError(409, { message: "This live class has already finished." }))).toBe(true);
    expect(isTerminalRejoinError(httpError(401, { errors: { code: "session_replaced" } }))).toBe(true);

    expect(isTerminalRejoinError(new Error("Network Error"))).toBe(false);
    expect(isTerminalRejoinError(httpError(502))).toBe(false);
    expect(isTerminalRejoinError(httpError(429))).toBe(false);
    expect(isTerminalRejoinError(httpError(401, { errors: { code: "token_not_valid" } }))).toBe(false);
    expect(isTerminalRejoinError(httpError(409, { message: "Stream state changed." }))).toBe(false);
    expect(isTerminalRejoinError(null)).toBe(false);
  });

  it("pauses while offline or hidden", () => {
    expect(canRetryMeetingNow({ navigator: { onLine: true }, document: { visibilityState: "visible" } })).toBe(true);
    expect(canRetryMeetingNow({ navigator: { onLine: false }, document: { visibilityState: "visible" } })).toBe(false);
    expect(canRetryMeetingNow({ navigator: { onLine: true }, document: { visibilityState: "hidden" } })).toBe(false);
  });
});

describe("stable device id", () => {
  it("is created once, valid for the server, and reused", () => {
    const store = storage();
    const first = getRealtimeDeviceId(store);
    expect(isValidDeviceId(first)).toBe(true);
    expect(store.values[DEVICE_ID_STORAGE_KEY]).toBe(first);
    expect(getRealtimeDeviceId(store)).toBe(first);
  });

  it("replaces a tampered value and survives blocked storage", () => {
    const store = storage({ [DEVICE_ID_STORAGE_KEY]: "<script>" });
    expect(isValidDeviceId(getRealtimeDeviceId(store))).toBe(true);
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    const a = getRealtimeDeviceId(blocked);
    expect(isValidDeviceId(a)).toBe(true);
    expect(getRealtimeDeviceId(blocked)).toBe(a);
  });
});

describe("live-class guard and eviction banner", () => {
  afterEach(() => resetLiveClassGuard());

  it("tracks playing classes and notifies listeners", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLiveClassGuard(listener);
    expect(isLiveClassActive()).toBe(false);
    const stopA = registerLiveClassPlayback("broadcast-1");
    const stopB = registerLiveClassPlayback("meeting-2");
    expect(isLiveClassActive()).toBe(true);
    stopA();
    stopA(); // idempotent
    expect(isLiveClassActive()).toBe(true);
    stopB();
    expect(isLiveClassActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("shows a non-blocking banner while a class plays, the dialog otherwise", () => {
    const render = () =>
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/join-live"]}>
          <SessionEvictionPrompt onUseThisDevice={() => {}} onSignOut={async () => {}} />
        </MemoryRouter>
      );
    expect(render()).toContain("You signed in on another device");

    const stop = registerLiveClassPlayback("broadcast-1");
    const html = render();
    expect(html).toContain("This class will keep playing here");
    expect(html).toContain("live-eviction-banner");
    expect(html).not.toContain('role="alertdialog"');
    stop();
  });

  it("signs the device out with the reason once its class has ended, even on the class page", () => {
    const render = (props) =>
      renderToStaticMarkup(
        <MemoryRouter initialEntries={["/join-live"]}>
          <SessionEvictionPrompt onUseThisDevice={() => {}} onSignOut={async () => {}} {...props} />
        </MemoryRouter>
      );
    const stop = registerLiveClassPlayback("broadcast-1");
    expect(render({ mode: "live" })).toContain("live-eviction-banner");

    const ended = render({ mode: "final", classEnded: true });
    expect(ended).toContain('role="alertdialog"');
    expect(ended).toContain("Your class has ended");
    expect(ended).not.toContain("live-eviction-banner");
    stop();

    // Off the class page, a device still finishing its class is told so.
    expect(render({ mode: "live" })).toContain("can only stay in the live class it was watching");
  });

  it("banner offers both actions", () => {
    const html = renderToStaticMarkup(<LiveEvictionBanner onUseThisDevice={() => {}} onSignOut={() => {}} />);
    expect(html).toContain("Use this device instead");
    expect(html).toContain("Sign out");
    expect(html).toContain("After that, this device will be signed out.");
  });
});

import { describe, expect, it } from "vitest";
import {
  disconnectMessage,
  normalizeConnectionQuality,
  normalizeDisconnectReason,
  resolveMeetingConnectionStrategy,
  shouldAutomaticallyReconnect,
} from "./realtimeConnection";

describe("realtime connection policy", () => {
  it("does not force every mobile listener through relay", () => {
    const strategy = resolveMeetingConnectionStrategy({
      browserWindow: { innerWidth: 390 },
      browserNavigator: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile",
        maxTouchPoints: 5,
        connection: { effectiveType: "4g" },
      },
    });

    expect(strategy.mobileListener).toBe(true);
    expect(strategy.relayFallbackEligible).toBe(true);
    expect(strategy.preferRelayTransport).toBe(false);
    expect(strategy.conservativeReceiveProfile).toBe(true);
  });

  it("uses relay only after an explicit fallback decision", () => {
    const strategy = resolveMeetingConnectionStrategy({
      forceRelayTransport: true,
      browserWindow: { innerWidth: 1440 },
      browserNavigator: { userAgent: "Desktop", maxTouchPoints: 0 },
    });

    expect(strategy.preferRelayTransport).toBe(true);
  });

  it("normalizes LiveKit disconnect reason values", () => {
    expect(normalizeDisconnectReason(2)).toBe("duplicate_identity");
    expect(normalizeDisconnectReason(15)).toBe("media_failure");
    expect(normalizeDisconnectReason(undefined)).toBe("unknown");
  });

  it("normalizes LiveKit numeric connection quality values", () => {
    expect(normalizeConnectionQuality(0)).toBe("poor");
    expect(normalizeConnectionQuality(1)).toBe("good");
    expect(normalizeConnectionQuality(2)).toBe("excellent");
    expect(normalizeConnectionQuality(3)).toBe("lost");
    expect(normalizeConnectionQuality(undefined)).toBe("unknown");
  });

  it("retries transient network and server disconnects", () => {
    expect(shouldAutomaticallyReconnect(3)).toBe(true);
    expect(shouldAutomaticallyReconnect(9)).toBe(true);
    expect(shouldAutomaticallyReconnect(14)).toBe(true);
    expect(shouldAutomaticallyReconnect(15)).toBe(true);
  });

  it("does not retry terminal policy disconnects", () => {
    expect(shouldAutomaticallyReconnect(1)).toBe(false);
    expect(shouldAutomaticallyReconnect(2)).toBe(false);
    expect(shouldAutomaticallyReconnect(4)).toBe(false);
    expect(shouldAutomaticallyReconnect(5)).toBe(false);
  });

  it("provides an actionable duplicate-session message", () => {
    expect(disconnectMessage(2)).toContain("another tab or device");
  });
});

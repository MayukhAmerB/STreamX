import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HOST_LINK } from "../../services/realtime/hostStudioController";
import HostStudioStatusChip, { describeDelivery, describeStudioLink } from "./HostStudioStatus";

describe("HostStudioStatusChip", () => {
  it("labels every studio link state", () => {
    expect(describeStudioLink(HOST_LINK.CONNECTED)).toEqual({ tone: "good", label: "Studio connected" });
    expect(describeStudioLink(HOST_LINK.RECONNECTING)).toEqual({ tone: "warn", label: "Reconnecting..." });
    expect(describeStudioLink(HOST_LINK.CONNECTING).tone).toBe("warn");
    expect(describeStudioLink(HOST_LINK.REPLACED).label).toMatch(/another tab/);
    expect(describeStudioLink(HOST_LINK.FAILED).tone).toBe("bad");
    expect(describeStudioLink(HOST_LINK.IDLE).label).toBe("Not connected");
  });

  it("reports delivery only while live", () => {
    expect(describeDelivery({ live: false, egress: { running: true } })).toBeNull();
    expect(describeDelivery({ live: true, egress: null }).label).toBe("Checking delivery...");
    expect(describeDelivery({ live: true, egress: { running: true } }).label).toBe("Delivering to viewers");
    expect(describeDelivery({ live: true, egress: { running: false } }).tone).toBe("bad");
    expect(describeDelivery({ live: true, egress: { running: null } }).label).toBe("Delivery unverified");
  });

  it("renders an accessible live status region", () => {
    const html = renderToStaticMarkup(
      <HostStudioStatusChip link={HOST_LINK.RECONNECTING} live egress={{ running: true, status: "EGRESS_ACTIVE" }} />
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Reconnecting...");
    expect(html).toContain("Delivering to viewers");
  });
});

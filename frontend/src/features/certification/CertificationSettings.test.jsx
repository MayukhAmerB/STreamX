// Certificate delivery settings: channel choice, WhatsApp opt-out, Hall of Fame listing.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, fire, renderTree } from "../../test-utils/renderTree";

const api = vi.hoisted(() => ({ fetchCertificationPreferences: vi.fn(), saveCertificationPreferences: vi.fn() }));
vi.mock("./certificationApi", () => api);
// Carbon's radio group inspects DOM classes in an effect; the in-memory renderer has no DOM.
vi.mock("@carbon/react", async () => {
  const { createElement } = await import("react");
  return {
    Tile: ({ children, ...rest }) => createElement("div", rest, children),
    RadioButtonGroup: ({ children, legendText }) => createElement("fieldset", null, createElement("legend", null, legendText), children),
    RadioButton: ({ labelText, value }) => createElement("label", { "data-value": value }, labelText),
  };
});

import CertificationSettings, { CertificationSettingsView } from "./CertificationSettings";

const PREFS = { delivery_channel: "both", whatsapp_opt_out: false, hall_of_fame_listed: true, has_phone: true, whatsapp_available: false };

describe("CertificationSettingsView", () => {
  it("shows the channel choice and both switches", () => {
    const html = renderToStaticMarkup(<CertificationSettingsView prefs={PREFS} />);
    expect(html).toContain("E-mail and WhatsApp");
    expect(html).toContain("No WhatsApp messages");
    expect(html).toContain("List me in the Hall of Fame");
    expect(html).toContain("never your real name");
  });

  it("explains why WhatsApp cannot be used", () => {
    expect(renderToStaticMarkup(<CertificationSettingsView prefs={{ ...PREFS, has_phone: false }} />)).toContain("Add a phone number");
    expect(renderToStaticMarkup(<CertificationSettingsView prefs={{ ...PREFS, whatsapp_opt_out: true }} />)).toContain("WhatsApp is off");
    expect(renderToStaticMarkup(<CertificationSettingsView prefs={null} />)).toBe("");
  });
});

describe("CertificationSettings", () => {
  let tree;
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
  });
  afterEach(async () => {
    await tree?.unmount?.();
  });

  it("saves the Hall of Fame opt-out and rolls back on failure", async () => {
    api.fetchCertificationPreferences.mockResolvedValue(PREFS);
    api.saveCertificationPreferences.mockResolvedValueOnce({ ...PREFS, hall_of_fame_listed: false }).mockRejectedValueOnce(new Error("x"));
    tree = await renderTree(<CertificationSettings />);
    await act(async () => {});
    const listed = () => tree.find((node) => node.props?.id === "certification-hall-of-fame");
    expect(listed().props["aria-checked"]).toBe(true);
    await fire(listed(), "onClick");
    expect(api.saveCertificationPreferences).toHaveBeenCalledWith({ hall_of_fame_listed: false });
    expect(listed().props["aria-checked"]).toBe(false);
    const optOut = () => tree.find((node) => node.props?.id === "certification-whatsapp-opt-out");
    await fire(optOut(), "onClick");
    expect(optOut().props["aria-checked"]).toBe(false);
    expect(tree.text()).toContain("Not saved");
  });
});

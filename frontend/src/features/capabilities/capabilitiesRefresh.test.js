import { afterEach, beforeEach, describe, expect, it } from "vitest";

globalThis.window = globalThis.window || new EventTarget();
const { default: apiClient, CAPABILITIES_STALE_EVENT, featureDisabledDetail } = await import("../../api/client");
const { CAPABILITY_REVEAL_EVENT, noteCapabilities, resetCapabilityReveal } = await import("./reveal");
const capabilities = (await import("../../__contracts__/ui-overhaul/capabilities.json")).default;
const errors = (await import("../../__contracts__/ui-overhaul/errors.json")).default;

describe("api client: feature_disabled marks capabilities stale", () => {
  let events;
  const onStale = (event) => events.push(event.detail);
  let adapter;

  beforeEach(() => {
    events = [];
    window.addEventListener(CAPABILITIES_STALE_EVENT, onStale);
    adapter = apiClient.defaults.adapter;
  });

  afterEach(() => {
    window.removeEventListener(CAPABILITIES_STALE_EVENT, onStale);
    apiClient.defaults.adapter = adapter;
  });

  function serve(status, data) {
    apiClient.defaults.adapter = async (config) => {
      if (String(config.url).includes("/auth/csrf/")) {
        return { status: 200, data: {}, headers: { "x-csrftoken": "token" }, config };
      }
      const error = new Error(String(status));
      error.config = config;
      error.response = { status, data, headers: {}, config };
      throw error;
    };
  }

  it("dispatches capabilities:stale with the feature and reason, and still rejects", async () => {
    serve(403, errors.feature_disabled);
    await expect(apiClient.post("/courses/", {})).rejects.toBeTruthy();
    expect(events).toEqual([{ feature: "teaching", reason: errors.feature_disabled.detail }]);
  });

  it("ignores other 403s and other statuses", async () => {
    serve(403, { code: "permission_denied", detail: "No." });
    await expect(apiClient.get("/x/")).rejects.toBeTruthy();
    serve(409, errors.feature_changed_meanwhile);
    await expect(apiClient.get("/y/")).rejects.toBeTruthy();
    expect(events).toEqual([]);
  });

  it("reads the code from the envelope or errors", () => {
    expect(featureDisabledDetail({ response: { status: 403, data: { errors: { code: "feature_disabled", feature: "teaching", detail: "Off." } } } })).toEqual({
      feature: "teaching",
      reason: "Off.",
    });
    expect(featureDisabledDetail({ response: { status: 403, data: "<html>" } })).toBeNull();
    expect(featureDisabledDetail(new Error("network"))).toBeNull();
  });
});

describe("capability reveal (M20)", () => {
  beforeEach(() => resetCapabilityReveal());

  it("flags a workspace that goes from disabled to enabled, once", () => {
    const seen = [];
    const onReveal = (event) => seen.push(event.detail.workspaces);
    window.addEventListener(CAPABILITY_REVEAL_EVENT, onReveal);
    expect(noteCapabilities(2, capabilities.instructor_off)).toEqual([]);
    expect(noteCapabilities(2, capabilities.instructor_on)).toEqual(["teach"]);
    expect(noteCapabilities(2, capabilities.instructor_on)).toEqual([]);
    window.removeEventListener(CAPABILITY_REVEAL_EVENT, onReveal);
    expect(seen).toEqual([["teach"]]);
  });

  it("does not reveal on first sight or for another user", () => {
    expect(noteCapabilities(2, capabilities.instructor_on)).toEqual([]);
    noteCapabilities(2, capabilities.instructor_off);
    expect(noteCapabilities(9, capabilities.instructor_on)).toEqual([]);
  });
});

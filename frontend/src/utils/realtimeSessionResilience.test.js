import { describe, expect, it } from "vitest";
import {
  reconcileActiveLivePayload,
  retainRealtimeSessionsOnRefresh,
} from "./realtimeSessionResilience";

describe("realtime session resilience", () => {
  it("retains the last successful session list when a refresh has no rows", () => {
    const previous = [{ id: 7, status: "live" }];
    expect(retainRealtimeSessionsOnRefresh(undefined, previous)).toBe(previous);
  });

  it("keeps an active player mounted when a session is temporarily absent", () => {
    const payload = { session: { id: 7, status: "live" }, mode: "broadcast" };
    expect(reconcileActiveLivePayload(payload, [])).toBe(payload);
  });

  it("clears an active player only after an explicit ended status", () => {
    const payload = { session: { id: 7, status: "live" }, mode: "broadcast" };
    expect(reconcileActiveLivePayload(payload, [{ id: 7, status: "ended" }])).toBeNull();
  });

  it("merges current server state without dropping the broadcast payload", () => {
    const payload = {
      session: { id: 7, status: "live", chat_enabled: true },
      mode: "broadcast",
      broadcast: { stream_embed_url: "https://stream.example/embed/video/" },
    };
    const result = reconcileActiveLivePayload(payload, [
      { id: 7, status: "live", chat_enabled: false },
    ]);
    expect(result.session.chat_enabled).toBe(false);
    expect(result.broadcast).toEqual(payload.broadcast);
  });
});

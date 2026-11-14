// LiveKit server API stand-in (Twirp JSON): egress start/stop/list and the
// RoomService calls the backend makes. A running stream egress "pushes RTMP"
// into the Owncast stub (it goes online), like the real chain
// Host Studio -> LiveKit egress -> Owncast.
import { createServer, readJson, sendJson } from "./http-util.mjs";

const STATUS = { STARTING: 0, ACTIVE: 1, ENDING: 2, COMPLETE: 3, FAILED: 4 };

export function createLivekitStub({ owncast, log = () => {} } = {}) {
  const state = { egresses: new Map(), participants: new Map(), calls: [], nextId: 1, failStarts: 0 };

  function reset() {
    state.egresses.clear();
    state.participants.clear();
    state.calls = [];
    state.nextId = 1;
    state.failStarts = 0;
  }

  function egressItem(egress) {
    return {
      egress_id: egress.id,
      room_name: egress.room,
      status: egress.status,
      started_at: String(egress.startedAt * 1_000_000),
      ended_at: egress.endedAt ? String(egress.endedAt * 1_000_000) : "0",
      error: egress.error || "",
      file_results: egress.file ? [{ filename: egress.file, size: "1024", duration: "42000000000" }] : [],
    };
  }

  function anyStreamEgressActive() {
    return [...state.egresses.values()].some((item) => item.kind === "stream" && item.status <= STATUS.ACTIVE);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    const path = url.pathname;
    if (path === "/__stub/state") {
      if (req.method === "POST") {
        const body = await readJson(req);
        if (body.reset) reset();
        if (body.participants && typeof body.participants === "object") {
          for (const [room, count] of Object.entries(body.participants)) state.participants.set(room, Number(count) || 0);
        }
        if (body.endEgress) {
          const egress = state.egresses.get(body.endEgress);
          if (egress) {
            egress.status = STATUS.FAILED;
            egress.endedAt = Date.now();
          }
          if (!anyStreamEgressActive()) owncast?.setOnline(false);
        }
        if (typeof body.failStarts === "number") state.failStarts = body.failStarts;
      }
      return sendJson(res, 200, {
        egresses: [...state.egresses.values()],
        participants: Object.fromEntries(state.participants),
        calls: state.calls.slice(-40),
      });
    }
    if (req.method !== "POST" || !path.startsWith("/twirp/")) {
      return sendJson(res, 200, { ok: true, service: "livekit-stub" });
    }
    const body = await readJson(req);
    const method = path.replace("/twirp/", "");
    state.calls.push(method);
    log(`livekit stub: ${method}`);
    switch (method) {
      case "livekit.Egress/StartParticipantEgress":
      case "livekit.Egress/StartRoomCompositeEgress":
      case "livekit.Egress/StartTrackCompositeEgress": {
        if (state.failStarts > 0) {
          state.failStarts -= 1;
          return sendJson(res, 503, { code: "unavailable", msg: "egress unavailable (stub)" });
        }
        const id = `EG_e2e_${state.nextId++}`;
        const fileOutput = body.file || body.file_outputs?.[0] || null;
        const file = fileOutput ? fileOutput.filepath || "" : "";
        state.egresses.set(id, {
          id,
          room: body.room_name || "",
          kind: fileOutput ? "file" : "stream",
          status: STATUS.ACTIVE,
          startedAt: Date.now(),
          endedAt: 0,
          file,
        });
        if (!fileOutput) owncast?.setOnline(true);
        return sendJson(res, 200, egressItem(state.egresses.get(id)));
      }
      case "livekit.Egress/StopEgress": {
        const egress = state.egresses.get(body.egress_id);
        if (!egress) return sendJson(res, 404, { code: "not_found", msg: "egress not found" });
        egress.status = STATUS.COMPLETE;
        egress.endedAt = Date.now();
        if (!anyStreamEgressActive()) owncast?.setOnline(false);
        return sendJson(res, 200, egressItem(egress));
      }
      case "livekit.Egress/ListEgress": {
        const items = [...state.egresses.values()]
          .filter((item) => (!body.egress_id || item.id === body.egress_id) && (!body.room_name || item.room === body.room_name))
          .map(egressItem);
        return sendJson(res, 200, { items });
      }
      case "livekit.RoomService/ListParticipants": {
        const count = state.participants.get(body.room) || 0;
        const participants = Array.from({ length: count }, (_, index) => ({
          sid: `PA_${index}`,
          identity: `e2e-participant-${index}`,
          state: 2,
          tracks: [],
        }));
        return sendJson(res, 200, { participants });
      }
      case "livekit.RoomService/DeleteRoom":
        state.participants.delete(body.room);
        return sendJson(res, 200, {});
      case "livekit.RoomService/ListRooms":
        return sendJson(res, 200, { rooms: [] });
      default:
        return sendJson(res, 200, {});
    }
  });

  return { server, state, reset };
}

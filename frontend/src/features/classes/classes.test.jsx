// Classes, Host-a-class and Host studio (UI overhaul WS-D1).
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { panelHref, STUDIO_PANELS } from "./BroadcastStudio";
import { createClassActions } from "./classActions";
import {
  activeClassSessions,
  buildJoinLink,
  canManageSession,
  confirmCopy,
  filterSessionsByMode,
  inferObsServerUrl,
  maskSecretValue,
  normalizeBroadcastProfile,
  sessionModeLabel,
  sessionRowActions,
  sessionStatus,
  sortSessions,
  studioPath,
  workspaceRootFor,
} from "./classesModel";
import { legacyClassesTarget } from "./LegacyClassesRedirect";
import SessionRow from "./SessionRow";
import { obsStartLabel } from "./StudioControls";
import { parseTimeoutMinutes } from "./useChatModeration";
import { hostClassPayload, initialHostClassForm } from "./useHostClassForm";
import { viewerStatusMessage } from "./useViewerBroadcast";

const admin = { id: 1, is_admin: true, full_name: "Ayesha Admin" };
const student = { id: 9, is_admin: false };
const obs = { id: 1, title: "E2E OBS broadcast", session_type: "broadcasting", stream_service: "obs_stream", status: "scheduled", can_manage: true };
const studio = { id: 2, title: "E2E Host Studio broadcast", session_type: "broadcasting", stream_service: "alsyed_stream", status: "live", stream_status: "live" };
const meeting = { id: 3, title: "E2E mentoring meeting", session_type: "meeting", status: "scheduled", can_manage: true };

describe("class rows: one primary, danger only in the overflow", () => {
  it("broadcast rows open the Host Studio and keep Stop/Delete in the overflow, flagged as danger", () => {
    const actions = sessionRowActions(obs, admin);
    expect(actions.primary).toEqual({ key: "studio", label: "Open Host Studio" });
    expect(actions.copyLink).toBe(true);
    expect(actions.overflow.map((item) => item.key)).toEqual(["stage", "chat", "stop", "delete"]);
    expect(actions.overflow.filter((item) => item.danger).map((item) => item.key)).toEqual(["stop", "delete"]);
  });

  it("meeting rows open the meeting room; only Delete is in the overflow", () => {
    const actions = sessionRowActions(meeting, admin);
    expect(actions.primary.label).toBe("Open meeting room");
    expect(actions.overflow).toEqual([{ key: "delete", label: "Delete class", danger: true }]);
  });

  it("people who cannot manage a class can only watch it", () => {
    const actions = sessionRowActions({ ...obs, can_manage: false }, student);
    expect(actions.primary.key).toBe("watch");
    expect(actions.overflow).toEqual([]);
    expect(canManageSession({ ...obs, can_manage: false, is_host: true }, student)).toBe(true);
  });

  it("renders exactly one primary button and no danger button outside the overflow", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ul>
          <SessionRow session={obs} user={admin} onAction={() => {}} />
        </ul>
      </MemoryRouter>
    );
    const buttons = [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((match) => match[1].replace(/<[^>]+>/g, "").trim());
    expect(buttons.filter((label) => label === "Open Host Studio")).toHaveLength(1);
    expect(buttons.some((label) => /Delete|Stop/.test(label))).toBe(false);
    expect(markup).toContain("Copy link");
    expect(markup).toContain('aria-label="More actions for E2E OBS broadcast"');
    expect(markup).toContain("Broadcast from OBS");
    expect(markup).toContain("Scheduled");
  });
});

describe("Stop and Delete ask first and name the class", () => {
  const harness = (answer) => {
    const confirm = vi.fn(async () => answer);
    const api = { stopRealtimeStream: vi.fn(async () => ({ data: { data: { ...obs, stream_status: "stopped" } } })), endRealtimeSession: vi.fn(async () => ({})) };
    const sessions = { replaceRow: vi.fn(), removeRow: vi.fn() };
    const controller = { getSnapshot: () => ({ sessionId: obs.id }), disconnect: vi.fn() };
    const showToast = vi.fn();
    return { confirm, api, sessions, controller, showToast, actions: createClassActions({ confirm, api, sessions, controller, showToast }) };
  };

  it("does nothing when the host says no", async () => {
    const h = harness(false);
    expect(await h.actions.remove(obs)).toBe(false);
    expect(await h.actions.stop(obs)).toBe(false);
    expect(h.api.endRealtimeSession).not.toHaveBeenCalled();
    expect(h.api.stopRealtimeStream).not.toHaveBeenCalled();
    expect(h.confirm.mock.calls[0][0]).toMatchObject({ title: "Delete “E2E OBS broadcast”?", objectName: "E2E OBS broadcast", danger: true });
    expect(h.confirm.mock.calls[1][0]).toMatchObject({ title: "Stop the broadcast of “E2E OBS broadcast”?", confirmLabel: "Stop broadcast" });
  });

  it("deletes after a yes, removes the row and releases the studio connection", async () => {
    const h = harness(true);
    expect(await h.actions.remove(obs)).toBe(true);
    expect(h.api.endRealtimeSession).toHaveBeenCalledWith(obs.id);
    expect(h.sessions.removeRow).toHaveBeenCalledWith(obs.id);
    expect(h.controller.disconnect).toHaveBeenCalled();
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Class deleted." }));
  });

  it("stops after a yes and updates the row", async () => {
    const h = harness(true);
    await h.actions.stop(obs);
    expect(h.api.stopRealtimeStream).toHaveBeenCalledWith(obs.id);
    expect(h.sessions.replaceRow).toHaveBeenCalledWith(expect.objectContaining({ stream_status: "stopped" }));
  });

  it("every dialog names its object", () => {
    for (const kind of ["stop", "delete", "stop-live", "resync-key", "delete-recording"]) {
      expect(confirmCopy(kind, obs).objectName).toBe("E2E OBS broadcast");
    }
  });
});

describe("classes model", () => {
  it("status uses the one vocabulary", () => {
    expect(sessionStatus(obs)).toEqual({ key: "scheduled", label: "Scheduled" });
    expect(sessionStatus(studio)).toEqual({ key: "live", label: "Live" });
    expect(sessionStatus({ ...studio, stream_status: "interrupted" }).label).toBe("Host reconnecting");
    expect(sessionStatus({ ...studio, stream_status: "starting" }).key).toBe("processing");
    expect(sessionStatus({ ...meeting, status: "live" }).key).toBe("live");
    expect(sessionModeLabel(meeting)).toBe("Interactive meeting");
    expect(sessionModeLabel(studio)).toBe("Broadcast from the browser");
  });

  it("lists live first, then newest, and only meetings and broadcasts that have not ended", () => {
    const rows = [
      { ...obs, created_at: "2026-11-01" },
      { ...studio, created_at: "2026-10-01" },
      { ...meeting, created_at: "2026-11-05" },
      { id: 4, session_type: "broadcasting", status: "ended" },
      { id: 5, session_type: "other", status: "live" },
    ];
    const active = activeClassSessions(rows);
    expect(active.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(sortSessions(active).map((row) => row.id)).toEqual([2, 3, 1]);
    expect(filterSessionsByMode(active, "meeting").map((row) => row.id)).toEqual([3]);
    expect(filterSessionsByMode(active, "broadcast").map((row) => row.id)).toEqual([1, 2]);
  });

  it("builds workspace paths", () => {
    expect(workspaceRootFor("/console/teach/classes")).toBe("/console/teach");
    expect(workspaceRootFor("/console/admin/classes/4/studio")).toBe("/console/admin");
    expect(workspaceRootFor("/broadcasting", { isAdmin: true })).toBe("/console/admin");
    expect(workspaceRootFor("/broadcasting", { isAdmin: false })).toBe("/console/teach");
    expect(studioPath("/console/admin", 7)).toBe("/console/admin/classes/7/studio");
    expect(studioPath("/console/admin", 7, "chat")).toBe("/console/admin/classes/7/studio?panel=chat");
  });

  it("keeps the old helpers' behaviour", () => {
    expect(maskSecretValue("abc")).toBe("•".repeat(12));
    expect(maskSecretValue("")).toBe("");
    expect(normalizeBroadcastProfile({ fps: 99, capture_width: "x" })).toMatchObject({ fps: 30, capture_width: 640 });
    expect(inferObsServerUrl({ location: { hostname: "alsyed.test" } })).toBe("rtmp://alsyed.test:1935/live");
    expect(inferObsServerUrl(null)).toBe("rtmp://your-server:1935/live");
    expect(buildJoinLink({ id: 3 }, "https://x.test")).toBe("https://x.test/join-live?session=3");
    expect(buildJoinLink({ id: 3, join_url: "https://y/join" }, "https://x.test")).toBe("https://y/join");
    expect(obsStartLabel({ stream_status: "" })).toBe("Start Live");
    expect(obsStartLabel({ stream_status: "stopped" })).toBe("Resume OBS");
  });
});

describe("Host a class sends the same payloads as the old pages", () => {
  it("broadcast from the browser", () => {
    const payload = hostClassPayload({
      ...initialHostClassForm,
      title: "Fri batch",
      linked_live_class_id: "4",
      target_module_id: "9",
      stream_embed_url: "https://embed",
      rtmp_target_url: "rtmp://x",
    });
    expect(payload).toEqual({
      title: "Fri batch",
      description: "",
      linked_live_class_id: 4,
      target_module_id: 9,
      session_type: "broadcasting",
      stream_service: "alsyed_stream",
      obs_stream_key: "",
      meeting_capacity: 200,
      max_audience: 500,
      allow_overflow_broadcast: true,
      stream_embed_url: "https://embed",
      chat_embed_url: "",
      rtmp_target_url: "rtmp://x",
    });
  });

  it("broadcast from OBS sends the OBS server as the RTMP target and no embed links", () => {
    const payload = hostClassPayload({
      ...initialHostClassForm,
      linked_live_class_id: "4",
      stream_service: "obs_stream",
      stream_embed_url: "ignored",
      obs_stream_server_url: "rtmp://host:1935/live",
    });
    expect(payload).toMatchObject({ stream_service: "obs_stream", stream_embed_url: "", rtmp_target_url: "rtmp://host:1935/live", target_module_id: null });
  });

  it("interactive meeting", () => {
    expect(hostClassPayload({ ...initialHostClassForm, mode: "meeting", title: "Mentoring", linked_live_class_id: "2", meeting_capacity: "50" })).toEqual({
      title: "Mentoring",
      description: "",
      linked_live_class_id: 2,
      session_type: "meeting",
      meeting_capacity: 50,
      allow_overflow_broadcast: true,
      max_audience: 500,
    });
  });
});

describe("old URLs and the studio", () => {
  const root = "/console/admin";
  it("sends /broadcasting and /meeting to Classes, the live studio or the remembered room", () => {
    expect(legacyClassesTarget({ mode: "broadcast", root })).toBe("/console/admin/classes?mode=broadcast");
    expect(legacyClassesTarget({ mode: "broadcast", root, liveSessionId: 5 })).toBe("/console/admin/classes/5/studio");
    expect(legacyClassesTarget({ mode: "broadcast", root, search: "?session=8" })).toBe("/console/admin/classes/8/studio?watch=1");
    expect(legacyClassesTarget({ mode: "broadcast", root, resumeSessionId: 6 })).toBe("/console/admin/classes/6/studio");
    expect(legacyClassesTarget({ mode: "meeting", root })).toBe("/console/admin/classes?mode=meeting");
    expect(legacyClassesTarget({ mode: "meeting", root: "/console/teach", meetingSessionId: 3 })).toBe("/console/teach/classes/3/studio");
  });

  it("studio tabs are links that keep the path", () => {
    expect(STUDIO_PANELS.map((panel) => panel.label)).toEqual(["Setup", "Chat", "Recordings", "Viewer"]);
    expect(panelHref("/console/admin/classes/1/studio", "?panel=chat&watch=1", "setup")).toBe("/console/admin/classes/1/studio");
    expect(panelHref("/console/admin/classes/1/studio", "", "recordings")).toBe("/console/admin/classes/1/studio?panel=recordings");
  });

  it("chat timeouts are 1-1440 minutes", () => {
    expect(parseTimeoutMinutes("10")).toEqual({ minutes: 10 });
    expect(parseTimeoutMinutes("0").error).toMatch(/between 1 and 1440/);
    expect(parseTimeoutMinutes("abc").error).toBeTruthy();
  });

  it("viewer status lines", () => {
    expect(viewerStatusMessage({ session: { status: "ended" } })).toBe("This broadcast session has ended.");
    expect(viewerStatusMessage({ session: { status: "live" }, broadcast: { stream_status: "starting" } })).toMatch(/reconnecting OBS/);
    expect(viewerStatusMessage({ session: { status: "live" }, broadcast: { stream_status: "stopped" } })).toMatch(/temporarily offline/);
    expect(viewerStatusMessage({ session: { status: "live" }, broadcast: { stream_status: "live" } })).toBe("");
  });
});

describe("row overflow menu (kit styles, menu semantics)", () => {
  it("opens a labelled menu, puts a divider before the first danger item and closes after a choice", async () => {
    const { default: RowOverflowMenu } = await import("./RowOverflowMenu");
    const { fire, renderTree, textOf } = await import("../../test-utils/renderTree");
    const onSelect = vi.fn();
    const items = sessionRowActions(obs, admin).overflow;
    const tree = await renderTree(<RowOverflowMenu label="More actions for E2E OBS broadcast" items={items} onSelect={onSelect} />);
    const trigger = tree.find((node) => node.type === "button" && node.props["aria-haspopup"] === "menu");
    expect(trigger.props["aria-label"]).toBe("More actions for E2E OBS broadcast");
    expect(trigger.props["aria-expanded"]).toBe(false);
    expect(tree.find((node) => node.props?.role === "menu")).toBeNull();
    await fire(trigger, "onClick");
    expect(tree.find((node) => node.props?.role === "menu").props["aria-label"]).toBe("More actions for E2E OBS broadcast");
    const entries = tree.all((node) => node.props?.role === "menuitem");
    expect(entries.map((node) => textOf(node))).toEqual(["Open stage control", "Chat moderation", "Stop broadcast", "Delete class"]);
    expect(entries.filter((node) => node.props.className.includes("--danger")).map((node) => textOf(node))).toEqual(["Stop broadcast", "Delete class"]);
    const dividers = tree.all((node) => node.type === "li" && node.props.className === "cls-menu__divider");
    expect(dividers.map((node) => textOf(node))).toEqual(["Stop broadcast"]);
    await fire(entries[2], "onClick");
    expect(onSelect).toHaveBeenCalledWith("stop");
    expect(tree.find((node) => node.props?.role === "menu")).toBeNull();
    await tree.unmount();
  });

  it("renders nothing when there is nothing in the overflow", async () => {
    const { default: RowOverflowMenu } = await import("./RowOverflowMenu");
    expect(renderToStaticMarkup(<RowOverflowMenu label="More" items={[]} onSelect={() => {}} />)).toBe("");
  });
});

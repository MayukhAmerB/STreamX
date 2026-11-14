// Classes (T2): every meeting and broadcast you can run, one primary action
// per row, and one "Host a class" flow with a mode choice (plan §3.5).
// Replaces the Meeting and Broadcasting pages. OWNER: WS-D1.
import { Add, VideoChat } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { endRealtimeSession, stopRealtimeStream } from "../../api/realtime";
import { useAuth } from "../../hooks/useAuth";
import { getHostStudioController } from "../../services/realtime/hostStudioController";
import { apiMessage } from "../../utils/api";
import { copyTextToClipboard } from "../../utils/clipboard";
import { EmptyState, ErrorState, PageHeader, PageSkeleton, ScrollTabs, T2List, useToast } from "../app-shell/ui";
import { createClassActions } from "./classActions";
import HostClassPanel from "./HostClassPanel";
import SessionRow from "./SessionRow";
import {
  MODE_BROADCAST,
  MODE_MEETING,
  buildJoinLink,
  filterSessionsByMode,
  isMeetingSession,
  isSessionOnAir,
  sortSessions,
  studioPath,
  workspaceRootFor,
} from "./classesModel";
import useConfirm from "./useConfirm";
import { useClassSessions, useLiveClassOptions } from "./useClassSessions";
import useHostClassForm from "./useHostClassForm";
import "./classes.scss";

const FILTERS = [
  { key: "", label: "All" },
  { key: MODE_BROADCAST, label: "Broadcasts" },
  { key: MODE_MEETING, label: "Meetings" },
];

function LiveBanner({ session, root }) {
  if (!session) return null;
  return (
    <div className="cls-banner" role="status">
      <span className="cls-banner__dot" aria-hidden="true" />
      <p className="cls-banner__text">
        You are live in <strong>{session.title}</strong>.
      </p>
      <Link className="cls-banner__link" to={studioPath(root, session.id)}>
        Return to the studio
      </Link>
    </div>
  );
}

export default function ClassesPage() {
  const { user, isAdmin } = useAuth() || {};
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { showToast } = useToast();
  const [dialog, confirm] = useConfirm();
  const root = workspaceRootFor(pathname, { isAdmin });
  const sessions = useClassSessions();
  const [busyId, setBusyId] = useState(null);

  const mode = [MODE_BROADCAST, MODE_MEETING].includes(params.get("mode")) ? params.get("mode") : "";
  const panelOpen = params.get("new") === "1";
  const liveClasses = useLiveClassOptions(panelOpen);

  const setParam = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const formState = useHostClassForm({
    initialMode: mode || MODE_BROADCAST,
    onCreated: (created, createdMode) => {
      sessions.addRow(created);
      showToast({
        kind: "success",
        title: "Class created",
        subtitle: createdMode === MODE_MEETING ? "The meeting room is opening." : "Go live from the studio when you are ready.",
      });
      navigate(studioPath(root, created.id));
    },
  });

  const ordered = useMemo(() => sortSessions(sessions.rows), [sessions.rows]);
  const visible = useMemo(() => filterSessionsByMode(ordered, mode), [ordered, mode]);
  const counts = useMemo(
    () => ({
      "": ordered.length,
      [MODE_BROADCAST]: filterSessionsByMode(ordered, MODE_BROADCAST).length,
      [MODE_MEETING]: filterSessionsByMode(ordered, MODE_MEETING).length,
    }),
    [ordered]
  );

  const controller = getHostStudioController();
  const liveSnapshot = controller.getSnapshot();
  const liveSession = liveSnapshot.live ? ordered.find((row) => row.id === liveSnapshot.sessionId) : null;
  // One champagne action per view: the live class's studio when you are on
  // air, otherwise "Host a class".
  const accentRowId = liveSession?.id ?? null;

  const openPanel = () => {
    formState.reset(mode || MODE_BROADCAST);
    setParam("new", "1");
  };
  const closePanel = () => setParam("new", "");

  const copyLink = async (session) => {
    const link = buildJoinLink(session);
    if (!link) {
      showToast({ kind: "error", title: "Join link is not ready yet." });
      return;
    }
    try {
      await copyTextToClipboard(link);
      showToast({ kind: "success", title: "Join link copied", subtitle: session.title });
    } catch (err) {
      showToast({ kind: "error", title: "Unable to copy join link.", subtitle: apiMessage(err, "") });
    }
  };

  const danger = createClassActions({
    confirm,
    api: { stopRealtimeStream, endRealtimeSession },
    sessions,
    controller,
    showToast,
    setBusyId,
  });

  const onAction = (key, session) => {
    if (key === "studio") navigate(studioPath(root, session.id));
    else if (key === "chat") navigate(studioPath(root, session.id, "chat"));
    else if (key === "stage") navigate(`/join-live?session=${session.id}`);
    else if (key === "watch") navigate(isMeetingSession(session) ? studioPath(root, session.id) : `/join-live?session=${session.id}`);
    else if (key === "copy") copyLink(session);
    else if (key === "stop") danger.stop(session);
    else if (key === "delete") danger.remove(session);
  };

  const onAir = ordered.filter(isSessionOnAir).length;

  return (
    <>
      <T2List
        header={
          <PageHeader
            title="Classes"
            eyebrow={null}
            description={
              onAir
                ? `${onAir} on air now. Open a studio to run it, or host a new class.`
                : "Host live classes as a broadcast or an interactive meeting. Every class is recorded."
            }
            actions={
              <Button
                kind={accentRowId ? "secondary" : "primary"}
                className={accentRowId ? "cls-host-button" : "cls-host-button sc-button--accent cls-accent"}
                renderIcon={Add}
                onClick={openPanel}
              >
                Host a class
              </Button>
            }
          />
        }
        toolbar={
          ordered.length ? (
            <ScrollTabs
              label="Show classes"
              activeKey={mode || "all"}
              tabs={FILTERS.map((filter) => ({
                key: filter.key || "all",
                label: filter.label,
                badge: counts[filter.key],
                href: `${pathname}${filter.key ? `?mode=${filter.key}` : ""}`,
              }))}
            />
          ) : null
        }
      >
        <LiveBanner session={liveSession} root={root} />
        {sessions.loading ? <PageSkeleton label="Loading classes" count={2} /> : null}
        {!sessions.loading && sessions.error ? <ErrorState error={sessions.error} onRetry={sessions.reload} /> : null}
        {!sessions.loading && !sessions.error && !visible.length ? (
          <EmptyState
            icon={VideoChat}
            title={ordered.length ? "No classes of this kind right now." : "No classes yet."}
            body={ordered.length ? "Show all classes, or host a new one." : "Host your first class: pick a broadcast or an interactive meeting."}
            action={
              <button type="button" className="cls-link-button" onClick={ordered.length ? () => setParam("mode", "") : openPanel}>
                {ordered.length ? "Show all classes" : "Host a class"}
              </button>
            }
          />
        ) : null}
        {visible.length ? (
          <ul className="cls-list" aria-label="Classes">
            {visible.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                user={user}
                busy={busyId === session.id}
                accent={session.id === accentRowId}
                onAction={onAction}
              />
            ))}
          </ul>
        ) : null}
      </T2List>
      <HostClassPanel open={panelOpen} onClose={closePanel} liveClasses={liveClasses} formState={formState} />
      {dialog}
    </>
  );
}

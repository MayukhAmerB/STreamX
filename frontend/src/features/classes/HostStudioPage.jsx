// Host studio (T5) at /console/{ws}/classes/:sessionId/studio: the
// broadcast studio or the meeting room of one class. OWNER: WS-D1.
import { ArrowLeft, Copy } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { getRealtimeSession } from "../../api/realtime";
import { useAuth } from "../../hooks/useAuth";
import { apiData, apiMessage } from "../../utils/api";
import { ErrorState, NotFoundState, PageSkeleton, StatusTag, T5Studio } from "../app-shell/ui";
import BroadcastStudio from "./BroadcastStudio";
import MeetingStudio from "./MeetingStudio";
import StudioStatus from "./StudioStatus";
import {
  buildJoinLink,
  canManageSession,
  classesPath,
  isMeetingSession,
  sessionModeLabel,
  sessionStatus,
  workspaceRootFor,
} from "./classesModel";
import useConfirm from "./useConfirm";
import useCopyToast from "./useCopyToast";
import "./classes.scss";

function StudioHeader({ session, root, studio }) {
  const copy = useCopyToast();
  const status = sessionStatus(session);
  const course = session?.linked_course?.title || session?.linked_live_class?.linked_course_title || "";
  return (
    <header className="cls-studio__header">
      <Link className="cls-back" to={classesPath(root)}>
        <ArrowLeft size={16} aria-hidden="true" />
        <span>Classes</span>
      </Link>
      <div className="cls-studio__titlebar">
        <div className="cls-studio__heading">
          <h1 className="cls-studio__title">{session.title}</h1>
          <p className="cls-studio__meta">
            <StatusTag status={status.key}>{status.label}</StatusTag>
            <span>{[sessionModeLabel(session), course].filter(Boolean).join(" · ")}</span>
          </p>
        </div>
        <div className="cls-studio__header-actions">
          {studio && !studio.obsMode ? (
            <StudioStatus
              link={studio.linked ? studio.studioLink.link : undefined}
              live={studio.linked && studio.studioLink.live}
              egress={studio.linked ? studio.studioLink.egress : null}
            />
          ) : null}
          <Button
            kind="ghost"
            size="md"
            renderIcon={Copy}
            onClick={() => copy(buildJoinLink(session), "Join link copied.", "Join link is not ready yet.", "Unable to copy join link.")}
          >
            Copy link
          </Button>
        </div>
      </div>
    </header>
  );
}

export default function HostStudioPage() {
  const { sessionId } = useParams();
  const { pathname } = useLocation();
  const { user, isAdmin } = useAuth() || {};
  const root = workspaceRootFor(pathname, { isAdmin });
  const [state, setState] = useState({ session: null, loading: true, error: "", notFound: false });
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const session = apiData(await getRealtimeSession(sessionId), null);
      setState({ session, loading: false, error: "", notFound: !session });
    } catch (err) {
      const status = Number(err?.response?.status || 0);
      setState({ session: null, loading: false, error: apiMessage(err, "Unable to open this class."), notFound: status === 404 });
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSession = useCallback((latest) => {
    if (!latest?.id) return;
    setState((current) => (current.session && current.session.id !== latest.id ? current : { ...current, session: latest }));
  }, []);

  if (state.loading && !state.session) return <PageSkeleton label="Opening the studio" count={1} />;
  if (state.notFound || (!state.session && !state.error)) {
    return (
      <NotFoundState
        title="This class does not exist"
        body="It may have ended or been deleted."
        backHref={classesPath(root)}
        backLabel="Back to Classes"
      />
    );
  }
  if (!state.session) return <ErrorState error={state.error} onRetry={load} />;

  const session = state.session;
  const header = (studio) => <StudioHeader session={session} root={root} studio={studio} />;
  const meeting = isMeetingSession(session);
  const manage = canManageSession(session, user);

  return (
    <T5Studio
      main={
        <>
          {meeting ? (
            <MeetingStudio session={session} onSession={onSession} header={() => header(null)} />
          ) : manage ? (
            <BroadcastStudio
              session={session}
              onSession={onSession}
              confirm={confirm}
              header={header}
              uploadHref={`${root}/recordings/upload`}
            />
          ) : (
            <NotFoundState
              title="Only the host can run this class"
              body="You can still watch it from the live classes page."
              backHref={`/join-live?session=${session.id}`}
              backLabel="Watch the class"
            />
          )}
          {dialog}
        </>
      }
    />
  );
}

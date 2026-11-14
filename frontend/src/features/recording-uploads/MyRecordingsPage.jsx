// My recordings (T2) at /console/teach/recordings: the recordings you
// uploaded, with their state (processing, published, failed) and one way to
// add another. Server recordings of each class live in that class's studio
// (Recordings tab). OWNER: WS-D1.
import "./RecordingUploads.scss";

import { CloudUpload, VideoChat } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { apiData, apiMessage } from "../../utils/api";
import { EmptyState, ErrorState, PageHeader, PageSkeleton, T2List } from "../app-shell/ui";
import { classesPath, workspaceRootFor } from "../classes/classesModel";
import RecentUploads from "./RecentUploads";
import { listMyUploads } from "./recordingUploadsApi";

export default function MyRecordingsPage() {
  const { pathname } = useLocation();
  const { isAdmin } = useAuth() || {};
  const root = workspaceRootFor(pathname, { isAdmin });
  const [state, setState] = useState({ items: [], loading: true, error: "" });

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    listMyUploads()
      .then((response) => setState({ items: apiData(response, []), loading: false, error: "" }))
      .catch((error) => setState({ items: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);
  useEffect(() => load(), [load]);

  return (
    <T2List
      header={
        <PageHeader
          title="My recordings"
          eyebrow={null}
          description="Every class is recorded by the server. Upload a better copy from OBS here; each class's own recording is in its studio."
          actions={
            <Button as={Link} to={`${root}/recordings/upload`} kind="primary" className="sc-button--accent rup-accent" renderIcon={CloudUpload}>
              Upload a recording
            </Button>
          }
        />
      }
    >
      {state.loading ? <PageSkeleton label="Loading recordings" count={2} variant="form" /> : null}
      {!state.loading && state.error ? <ErrorState error={state.error} onRetry={load} /> : null}
      {!state.loading && !state.error && !state.items.length ? (
        <EmptyState
          icon={VideoChat}
          title="No uploaded recordings yet."
          body="The server records every class you host. Open a class's studio to see its recording."
          action={
            <Link className="rup-link rup-link--strong" to={classesPath(root)}>
              Open Classes
            </Link>
          }
        />
      ) : null}
      {!state.loading && state.items.length ? <RecentUploads items={state.items} /> : null}
    </T2List>
  );
}

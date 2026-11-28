// Studio "Setup" tab: OBS server URL and key (copy, reveal, re-sync) and
// the links to share (join, stream, chat). OWNER: WS-D1.
import { Launch, Renew } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useState } from "react";
import { rotateRealtimeStreamKey } from "../../api/realtime";
import { resolveBroadcastEmbedUrls } from "../../utils/broadcastUrls";
import { apiData, apiMessage } from "../../utils/api";
import { useToast } from "../app-shell/ui";
import ClassDetailsCard from "./ClassDetailsCard";
import SecretField from "./SecretField";
import { buildJoinLink, confirmCopy, isObsStreamMode } from "./classesModel";
import useCopyToast from "./useCopyToast";

export function sessionUrls(session, viewerPayload) {
  const fallback = viewerPayload?.session?.id === session?.id ? viewerPayload?.broadcast : null;
  const urls = resolveBroadcastEmbedUrls({
    streamEmbedUrl: session?.stream_embed_url || fallback?.stream_embed_url,
    chatEmbedUrl: session?.chat_embed_url || fallback?.chat_embed_url,
  });
  return { streamUrl: urls.streamEmbedUrl, chatUrl: urls.writableChatEmbedUrl || urls.chatEmbedUrl };
}

function openInNewTab(url, showToast) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) {
    showToast({ kind: "warning", title: "Popup blocked", subtitle: "Allow popups, or copy the chat link instead." });
    return;
  }
  try {
    popup.opener = null;
    popup.location.replace(url);
  } catch {
    popup.location.href = url;
  }
}

export default function StudioSetupPanel({ session, viewerPayload, onSession, confirm, moduleOptions = [] }) {
  const { showToast } = useToast();
  const copy = useCopyToast();
  const [resyncing, setResyncing] = useState(false);
  const obs = isObsStreamMode(session);
  const { streamUrl, chatUrl } = sessionUrls(session, viewerPayload);
  const serverUrl = String(session?.obs_stream_server_url || "").trim();
  const streamKey = String(session?.obs_stream_key || "").trim();

  const resync = async () => {
    if (!(await confirm(confirmCopy("resync-key", session)))) return;
    setResyncing(true);
    try {
      const updated = apiData(await rotateRealtimeStreamKey(session.id), null);
      if (updated) onSession(updated);
      showToast({ kind: "success", title: "Stream key sent to the server again." });
    } catch (err) {
      showToast({ kind: "error", title: "Unable to re-sync the stream key.", subtitle: apiMessage(err, "") });
    } finally {
      setResyncing(false);
    }
  };

  return (
    <div className="cls-panel-stack">
      <ClassDetailsCard session={session} moduleOptions={moduleOptions} onSaved={onSession} />
      {obs ? (
        <section className="cls-section" aria-labelledby="cls-obs-title">
          <h2 id="cls-obs-title" className="cls-section__title">
            Connect OBS
          </h2>
          <p className="cls-help">In OBS open Settings › Stream, choose Custom, paste the server and the key, then press Start Streaming.</p>
          <SecretField
            id="cls-obs-server"
            label="Server URL"
            value={serverUrl}
            secret
            resetKey={session?.id}
            emptyText="OBS server URL unavailable"
            onCopy={() => copy(serverUrl, "OBS server URL copied.", "OBS server URL is not available for this session.")}
          />
          <SecretField
            id="cls-obs-key"
            label="Stream key"
            value={streamKey}
            secret
            resetKey={session?.id}
            emptyText="OBS stream key unavailable"
            onCopy={() => copy(streamKey, "OBS stream key copied.", "OBS stream key is not available for this session.")}
          />
          <div>
            <Button kind="ghost" size="sm" className="cls-ghost-align" renderIcon={Renew} disabled={resyncing} onClick={resync}>
              {resyncing ? "Re-syncing…" : "Re-sync key"}
            </Button>
          </div>
        </section>
      ) : null}
      <section className="cls-section" aria-labelledby="cls-share-title">
        <h2 id="cls-share-title" className="cls-section__title">
          Share
        </h2>
        <SecretField
          id="cls-join-link"
          label="Join link"
          value={buildJoinLink(session)}
          emptyText="Join link is not ready yet."
          onCopy={() => copy(buildJoinLink(session), "Join link copied.", "Join link is not ready yet.", "Unable to copy join link.")}
        />
        <SecretField
          id="cls-stream-url"
          label="Stream URL"
          value={streamUrl}
          secret
          resetKey={session?.id}
          emptyText="Available after the broadcast starts or a custom URL is set."
          onCopy={() => copy(streamUrl, "Stream URL copied.", "Stream URL is not ready yet.", "Unable to copy stream URL.")}
        />
        <SecretField
          id="cls-chat-url"
          label="Chat link"
          value={chatUrl}
          emptyText="Broadcast chat URL unavailable for this session."
          onCopy={() =>
            copy(chatUrl, "Broadcast chat link copied.", "Broadcast chat URL is not configured for this session.", "Unable to copy broadcast chat link.")
          }
        >
          {chatUrl ? (
            <Button kind="ghost" size="sm" className="cls-ghost-align" renderIcon={Launch} onClick={() => openInNewTab(chatUrl, showToast)}>
              Open chat in a new tab
            </Button>
          ) : null}
        </SecretField>
      </section>
    </div>
  );
}

// "Desktop uploader": personal upload tokens and the OBS set-up guide, in a
// secondary disclosure below the upload task (plan §3.5). It opens by
// itself when you already use tokens or right after a manual upload is
// published (the natural moment to automate it). OWNER: WS-D1.
import { Copy, TrashCan } from "@carbon/icons-react";
import { Button, TextInput } from "@carbon/react";
import { useEffect, useState } from "react";
import { PageNotification, PageSkeleton, StatusTag, useToast } from "../app-shell/ui";

const formatWhen = (value) =>
  value
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value))
    : "";

function SetupGuide() {
  return (
    <details className="rup-guide">
      <summary>Set up OBS and the desktop uploader</summary>
      <ol>
        <li>
          In OBS open <strong>Settings → Output → Recording</strong>. <strong>Recording Path</strong> is where OBS saves the file (by
          default <code>C:\Users\&lt;you&gt;\Videos</code>).
        </li>
        <li>
          In <strong>Settings → Advanced</strong> turn on <strong>Automatically remux to mp4</strong>. MKV files are accepted too and are
          converted on the server.
        </li>
        <li>
          In OBS open <strong>Tools → WebSocket Server Settings</strong>, enable the server (port 4455) and copy its password.
        </li>
        <li>
          Install <code>obs-uploader.exe</code> and put this in <code>%APPDATA%\obs-uploader\config.toml</code>:
          <pre className="rup-code">{`api_base = "https://api.alsyedinitiative.com/api"
token = "<the upload token>"
recordings_dir = 'C:\\Users\\<you>\\Videos'
obs_websocket_password = "<the OBS WebSocket password>"`}</pre>
        </li>
        <li>
          Run <code>obs-uploader.exe install-task</code> once: it starts with Windows and waits for OBS. Each recording goes to your live
          class (or the one that ended last) automatically.
        </li>
      </ol>
    </details>
  );
}

export function UploadTokensPanel({ tokens, loading, error, created, busy, onCreate, onRevoke, onReload }) {
  const [name, setName] = useState("OBS laptop");
  const { showToast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.token);
      showToast({ kind: "success", title: "Token copied" });
    } catch {
      showToast({ kind: "warning", title: "Copy it by hand", subtitle: "Select the token and copy it." });
    }
  };
  return (
    <div className="rup-tokens">
      <p className="rup-muted">
        The desktop uploader notices when OBS stops recording and uploads the file to that class on its own. It signs in with a personal
        upload token: the token can only upload class recordings, and you can revoke it at any time.
      </p>
      <form
        className="rup-row"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name);
        }}
      >
        <TextInput id="rup-token-name" labelText="Token name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" kind="tertiary" size="md" disabled={!name.trim() || busy}>
          Create upload token
        </Button>
      </form>
      {created ? (
        <div className="rup-token" role="status">
          <p className="rup-check-label">Copy this token now. It is shown only once.</p>
          <code className="rup-token__value" data-testid="new-upload-token">
            {created.token}
          </code>
          <Button kind="ghost" size="sm" renderIcon={Copy} onClick={copy}>
            Copy
          </Button>
        </div>
      ) : null}
      {loading ? <PageSkeleton label="Loading tokens" count={1} variant="form" /> : null}
      {error ? <PageNotification kind="error" title="Couldn't load tokens." subtitle={error} actionLabel="Try again" onAction={onReload} /> : null}
      {!loading && tokens.length ? (
        <ul className="rup-list" aria-label="Upload tokens">
          {tokens.map((token) => (
            <li key={token.id} className="rup-list__item">
              <div>
                <strong>{token.name}</strong> <span className="rup-muted">{token.prefix}…</span>
                <div className="rup-muted">{token.last_used_at ? `Last used ${formatWhen(token.last_used_at)}` : "Never used"}</div>
              </div>
              {token.active ? (
                <Button kind="danger--ghost" size="sm" renderIcon={TrashCan} disabled={busy} onClick={() => onRevoke(token)}>
                  Revoke
                </Button>
              ) : (
                <StatusTag status="off">{token.revoked_at ? "Revoked" : "Expired"}</StatusTag>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <SetupGuide />
    </div>
  );
}

/** The collapsible "Desktop uploader" section of the upload page. */
export default function DesktopUploaderSection({ autoOpen, activeCount, ...panel }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  return (
    <section className="rup-section" aria-labelledby="rup-tokens-title">
      <details className="rup-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="rup-disclosure__text">
            <span id="rup-tokens-title" className="rup-disclosure__title">
              Desktop uploader
            </span>
            <span className="rup-muted">
              {activeCount ? `${activeCount} active token${activeCount === 1 ? "" : "s"}` : "Upload from OBS automatically, no browser needed"}
            </span>
          </span>
        </summary>
        <div className="rup-disclosure__body">
          <UploadTokensPanel {...panel} />
        </div>
      </details>
    </section>
  );
}

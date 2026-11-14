// Chat moderation building blocks: people, recent messages, IP bans.
// OWNER: WS-D1.
import { Button, Select, SelectItem, TextInput } from "@carbon/react";
import { useState } from "react";
import {
  formatModerationTime,
  isChatMessageHidden,
  owncastIdentityKey,
  owncastIdentityLabel,
  owncastIdentityStatus,
  owncastMessagePreview,
} from "./classesModel";

function Badge({ tone = "neutral", children }) {
  return <span className={`cls-badge cls-badge--${tone}`}>{children}</span>;
}

export function ChatPeople({ chat, onBan }) {
  const [minutes, setMinutes] = useState(10);
  const { identities, selected, selectedKey, setSelectedKey, state, apply, timeoutUser } = chat;
  if (!identities.length) {
    return <p className="cls-help">No one has joined the chat yet. Ask viewers to open it, then refresh.</p>;
  }
  const busy = (...actions) => actions.includes(state.actionLoading);
  return (
    <div className="cls-chat-block">
      <Select
        id="cls-chat-person"
        labelText={`People in chat (${identities.length})`}
        value={selectedKey}
        onChange={(event) => setSelectedKey(event.target.value)}
      >
        {identities.map((identity) => (
          <SelectItem
            key={owncastIdentityKey(identity)}
            value={owncastIdentityKey(identity)}
            text={`${owncastIdentityLabel(identity)} · ${identity.platform_email || "no email"} · ${owncastIdentityStatus(identity)}`}
          />
        ))}
      </Select>
      {selected ? (
        <article className="cls-card" aria-label={`Chat actions for ${owncastIdentityLabel(selected)}`}>
          <div className="cls-card__head">
            <div>
              <p className="cls-card__title">{owncastIdentityLabel(selected)}</p>
              <p className="cls-help">
                {selected.platform_email || "No platform email"} · {selected.platform_role || "role unknown"}
              </p>
              <p className="cls-help cls-mono">Owncast ID: {selected.owncast_user_id || "-"}</p>
            </div>
            <div className="cls-badges">
              {selected.is_moderator ? <Badge>Moderator</Badge> : null}
              {selected.is_disabled ? <Badge tone="danger">Banned</Badge> : null}
              {selected.is_timeout_active ? <Badge tone="warning">Timeout</Badge> : null}
            </div>
          </div>
          {selected.timeout_until ? <p className="cls-help">Timeout until {formatModerationTime(selected.timeout_until)}</p> : null}
          <div className="cls-card__actions">
            {selected.is_disabled ? (
              <Button
                kind="tertiary"
                size="sm"
                disabled={busy("unban_user")}
                onClick={() =>
                  apply("unban_user", { owncast_user_id: selected.owncast_user_id }, `${owncastIdentityLabel(selected)} was unbanned.`)
                }
              >
                Unban
              </Button>
            ) : (
              <>
                <div className="cls-inline-form">
                  <TextInput
                    id="cls-timeout-minutes"
                    labelText="Timeout (minutes)"
                    type="number"
                    inputMode="numeric"
                    size="sm"
                    min={1}
                    max={1440}
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                  />
                  <Button kind="tertiary" size="sm" disabled={busy("timeout_user")} onClick={() => timeoutUser(selected, minutes)}>
                    Time out
                  </Button>
                </div>
                <Button kind="danger--ghost" size="sm" disabled={busy("ban_user")} onClick={() => onBan(selected)}>
                  Ban from chat
                </Button>
              </>
            )}
            <Button
              kind="ghost"
              size="sm"
              disabled={busy("grant_moderator", "revoke_moderator")}
              onClick={() =>
                apply(
                  selected.is_moderator ? "revoke_moderator" : "grant_moderator",
                  { owncast_user_id: selected.owncast_user_id },
                  selected.is_moderator ? "Owncast moderator removed." : "Owncast moderator granted."
                )
              }
            >
              {selected.is_moderator ? "Remove moderator" : "Make moderator"}
            </Button>
          </div>
        </article>
      ) : null}
    </div>
  );
}

export function ChatMessages({ chat }) {
  const { messages, state, apply } = chat;
  if (!messages.length) return <p className="cls-help">No recent messages yet.</p>;
  const busy = ["hide_messages", "show_messages"].includes(state.actionLoading);
  return (
    <ul className="cls-messages" aria-label="Recent chat messages">
      {messages.map((message) => {
        const hidden = isChatMessageHidden(message);
        return (
          <li key={message.id} className={`cls-message${hidden ? " is-hidden" : ""}`}>
            <div className="cls-message__head">
              <span className="cls-message__author">{message.user?.display_name || "Owncast user"}</span>
              <span className="cls-help">{formatModerationTime(message.timestamp)}</span>
            </div>
            <p className="cls-message__body">{owncastMessagePreview(message.body)}</p>
            <div className="cls-message__foot">
              {hidden ? <Badge tone="warning">Hidden</Badge> : <span />}
              <Button
                kind={hidden ? "ghost" : "danger--ghost"}
                size="sm"
                disabled={busy}
                onClick={() =>
                  apply(
                    hidden ? "show_messages" : "hide_messages",
                    { message_ids: [message.id] },
                    hidden ? "Message restored." : "Message hidden."
                  )
                }
              >
                {hidden ? "Show message" : "Hide message"}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ChatIpBans({ chat }) {
  const [ipInput, setIpInput] = useState("");
  const { ipBans, state, apply, banIp } = chat;
  return (
    <div className="cls-chat-block">
      <p className="cls-help">Use IP bans only for abuse. Banning a person already blocks their known addresses.</p>
      <form
        className="cls-inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await banIp(ipInput)) setIpInput("");
        }}
      >
        <TextInput id="cls-ban-ip" labelText="IP address" size="sm" value={ipInput} onChange={(event) => setIpInput(event.target.value)} />
        <Button kind="danger--tertiary" size="sm" type="submit" disabled={state.actionLoading === "ban_ip"}>
          Ban IP
        </Button>
      </form>
      {ipBans.length ? (
        <ul className="cls-messages" aria-label="IP bans">
          {ipBans.map((row) => {
            const ipAddress = String(row.ipAddress || row.ip_address || row.value || "").trim();
            return (
              <li key={`${ipAddress}-${row.createdAt || row.created_at || ""}`} className="cls-message">
                <div className="cls-message__head">
                  <span className="cls-message__author cls-mono">{ipAddress || "Unknown IP"}</span>
                  <span className="cls-help">Added {formatModerationTime(row.createdAt || row.created_at)}</span>
                </div>
                <div className="cls-message__foot">
                  <span />
                  <Button
                    kind="ghost"
                    size="sm"
                    disabled={!ipAddress || state.actionLoading === "unban_ip"}
                    onClick={() => apply("unban_ip", { ip_address: ipAddress }, `IP ${ipAddress} was unbanned.`)}
                  >
                    Unban IP
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="cls-help">No IP bans.</p>
      )}
    </div>
  );
}

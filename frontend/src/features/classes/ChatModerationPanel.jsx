// Studio "Chat" tab: switch chat on/off, people, recent messages, IP bans.
// Loads itself the first time it is shown. OWNER: WS-D1.
import { Renew } from "@carbon/icons-react";
import { Button, InlineNotification } from "@carbon/react";
import { useEffect } from "react";
import { ChatIpBans, ChatMessages, ChatPeople } from "./ChatModerationParts";
import { owncastIdentityLabel } from "./classesModel";

export default function ChatModerationPanel({ chat, confirm }) {
  const { state, loaded, chatEnabled, load, toggleChat, apply, banUser } = chat;

  useEffect(() => {
    if (!loaded && !state.loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first show only
  }, []);

  const onBan = async (identity) => {
    const ok = await confirm({
      title: `Ban ${owncastIdentityLabel(identity)} from chat?`,
      objectName: owncastIdentityLabel(identity),
      body: "They can still watch, but can no longer write in the chat.",
      confirmLabel: "Ban from chat",
      danger: true,
    });
    if (ok) await banUser(identity);
  };

  return (
    <div className="cls-panel-stack">
      <section className="cls-section" aria-labelledby="cls-chat-title">
        <div className="cls-section__head">
          <h2 id="cls-chat-title" className="cls-section__title">
            Chat
          </h2>
          <span className={`cls-pill cls-pill--${chatEnabled ? "good" : "idle"}`}>
            <span className="cls-pill__dot" aria-hidden="true" />
            {chatEnabled ? "Chat on" : "Chat off"}
          </span>
        </div>
        <div className="cls-card__actions">
          <Button
            kind="tertiary"
            size="sm"
            disabled={["disable_chat", "enable_chat"].includes(state.actionLoading)}
            onClick={toggleChat}
          >
            {chatEnabled ? "Turn chat off" : "Turn chat on"}
          </Button>
          <Button kind="ghost" size="sm" renderIcon={Renew} disabled={state.loading} onClick={() => load()}>
            Refresh
          </Button>
          <Button
            kind="ghost"
            size="sm"
            disabled={state.actionLoading === "sync_handles"}
            onClick={() => apply("sync_handles", {}, "Owncast handles synced.")}
          >
            Sync handles
          </Button>
        </div>
        {state.error ? <InlineNotification lowContrast kind="error" title="Chat" subtitle={state.error} hideCloseButton /> : null}
        {state.info && !state.error ? (
          <p className="cls-help" role="status">
            {state.info}
          </p>
        ) : null}
      </section>
      {loaded ? (
        <>
          <section className="cls-section" aria-labelledby="cls-chat-people">
            <h3 id="cls-chat-people" className="cls-section__subtitle">
              People
            </h3>
            <ChatPeople chat={chat} onBan={onBan} />
          </section>
          <section className="cls-section" aria-labelledby="cls-chat-messages">
            <h3 id="cls-chat-messages" className="cls-section__subtitle">
              Recent messages
            </h3>
            <ChatMessages chat={chat} />
          </section>
          <section className="cls-section" aria-labelledby="cls-chat-bans">
            <h3 id="cls-chat-bans" className="cls-section__subtitle">
              IP bans
            </h3>
            <ChatIpBans chat={chat} />
          </section>
        </>
      ) : (
        <p className="cls-help">{state.loading ? "Loading chat…" : "Press Refresh to load the chat."}</p>
      )}
    </div>
  );
}

// /console/admin: the Admin home (UI overhaul plan §4.4). OWNER: WS-G.
// Opens on what needs the admin: greeting + how many things wait, the
// command field (Ctrl/Cmd+K), the attention tiles (zero queues collapse into
// one line), today's classes, quick actions, platform switches and recent
// activity. Polls every 60 s while visible; a count that grows gets a
// "new" dot until the admin opens that queue.
import { ArrowRight, Calendar, CloudUpload, DocumentAdd, Flag, SettingsAdjust, Video } from "@carbon/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { ErrorState, StatusTag, useSkeletonGate } from "../app-shell/ui";
import { CommandPalette } from "../command-palette";
import ActivityList, { ActivityMoreLink } from "./ActivityList";
import { CommandField, SectionHeading, SkeletonBlocks } from "./AdminBits";
import { QUICK_ACTIONS } from "./adminSitemap";
import { fetchActivity, fetchAttention } from "./api";
import { changedKeys, splitQueues, summaryLine } from "./attentionModel";
import AttentionTiles from "./AttentionTiles";
import { firstName, greetingFor, timeOfDay } from "./format";
import SmartLink from "./SmartLink";
import useAdminData from "./useAdminData";
import "./admin.scss";

export const ATTENTION_POLL_MS = 60 * 1000;
const QUICK_ICONS = {
  "go-live": Video,
  "upload-recording": CloudUpload,
  "new-class": Calendar,
  "import-exam": Flag,
  "new-report-task": DocumentAdd,
  features: SettingsAdjust,
};

function TodaysClasses({ classes = [] }) {
  if (!classes.length) {
    return (
      <p className="adm-quiet">
        No classes on air or scheduled today.{" "}
        <SmartLink href="/console/admin/classes" className="adm-link">
          Classes and studio
        </SmartLink>
      </p>
    );
  }
  return (
    <ul className="adm-rows">
      {classes.map((item) => (
        <li key={item.id} className="adm-row">
          <span className="adm-row__time">{item.state === "live" ? "Now" : timeOfDay(item.starts_at) || "Today"}</span>
          <span className="adm-row__title">{item.title}</span>
          <StatusTag status={item.state === "live" ? "live" : "scheduled"} />
          <SmartLink href={item.href} className="adm-button adm-button--ghost adm-row__action">
            Open studio
          </SmartLink>
        </li>
      ))}
    </ul>
  );
}

function QuickActions() {
  return (
    <ul className="adm-quick">
      {QUICK_ACTIONS.map((task) => {
        const Icon = QUICK_ICONS[task.key] || ArrowRight;
        return (
          <li key={task.key}>
            <SmartLink href={task.href} className="adm-quick__item">
              <Icon size={20} aria-hidden="true" className="adm-quick__icon" />
              <span>{task.title}</span>
            </SmartLink>
          </li>
        );
      })}
    </ul>
  );
}

/** What a launch gate means right now, in one calm line (hackpath BUILD_PLAN §2.2). */
export const SWITCH_NOTES = Object.freeze({
  pentesting: { off: "Browsable. Every enrol, buy and subscribe button shows “Coming soon”.", on: "Courses with a confirmed, enabled plan can be bought." },
  memberships: { off: "No new subscriptions. Plans show “Coming soon”.", on: "Confirmed plans can be subscribed to." },
  labs_membership_required: { off: "The labs are as open as today.", on: "The labs ask for sign-in and a membership." },
});

function PlatformSwitches({ switches = [] }) {
  if (!switches.length) return null;
  return (
    <ul className="adm-switches">
      {switches.map((item) => {
        const note = SWITCH_NOTES[item.key]?.[item.enabled ? "on" : "off"];
        return (
          <li key={item.key} className="adm-switches__row" data-switch={item.key}>
            <span className="adm-switches__label">{item.label}</span>
            <StatusTag status={item.enabled ? "on" : "off"} />
            <SmartLink href={item.href} className="adm-link adm-switches__change" aria-label={`Change ${item.label}`}>
              Change
            </SmartLink>
            {note ? <span className="adm-switches__note">{note}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The stat strip under the greeting: one border-y band (PHILOSOPHY §2.6). */
export function HomeStats({ waiting = [], clear = [], classes = [], switches = [] }) {
  const items = waiting.reduce((total, queue) => total + (Number(queue.count) || 0), 0);
  const on = (switches || []).filter((item) => item.enabled).length;
  const stats = [
    { key: "waiting", value: items, label: items === 1 ? "item waiting" : "items waiting" },
    { key: "clear", value: clear.length, label: clear.length === 1 ? "queue clear" : "queues clear" },
    { key: "classes", value: (classes || []).length, label: "classes today" },
    { key: "switches", value: `${on}/${(switches || []).length}`, label: "switches on" },
  ];
  return (
    <ul className="adm-stats" aria-label="At a glance">
      {stats.map((stat) => (
        <li key={stat.key} data-stat={stat.key}>
          <span className="adm-stats__value">{stat.value}</span>
          <span className="adm-stats__label">{stat.label}</span>
        </li>
      ))}
    </ul>
  );
}

export default function AdminHomePage() {
  const auth = useAuth() || {};
  const attention = useAdminData(fetchAttention, { pollMs: ATTENTION_POLL_MS });
  const activity = useAdminData(() => fetchActivity({ limit: 6 }));
  const phase = useSkeletonGate(attention.loading && !attention.data);
  const [fresh, setFresh] = useState([]);
  const previous = useRef(null);
  const [now, setNow] = useState(() => new Date());

  const queues = attention.data?.queues;
  useEffect(() => {
    if (!queues) return;
    if (previous.current) {
      const grown = changedKeys(previous.current, queues);
      if (grown.length) setFresh((current) => [...new Set([...current, ...grown])]);
    }
    previous.current = queues;
    setNow(new Date());
  }, [queues]);

  const onVisit = useCallback((key) => setFresh((current) => current.filter((item) => item !== key)), []);

  const { waiting, clear } = splitQueues(queues || []);
  const name = firstName(auth.user);
  const salutation = greetingFor(now);
  const loaded = Boolean(attention.data);

  return (
    <div className="adm-page adm-home">
      {/* Ctrl/Cmd+K works here even before the shell mounts the palette (singleton). */}
      <CommandPalette />
      <header className="adm-home__header">
        <p className="adm-home__kicker">Admin · Today</p>
        <h1 className="adm-home__title">
          {salutation}
          {name ? (
            <>
              , <span className="adm-home__name">{name}</span>
            </>
          ) : null}
        </h1>
        <p className="adm-home__summary" aria-live="polite">
          {loaded ? summaryLine(waiting) : " "}
        </p>
        <CommandField />
        {loaded ? <HomeStats waiting={waiting} clear={clear} classes={attention.data?.live_today} switches={attention.data?.switches} /> : null}
      </header>

      <section className="adm-section" aria-labelledby="adm-attention-title">
        <SectionHeading id="adm-attention-title">Needs attention</SectionHeading>
        {attention.error && !loaded ? (
          <ErrorState error={attention.error} onRetry={() => attention.reload()} />
        ) : loaded ? (
          <>
            {attention.error ? <ErrorState error={attention.error} onRetry={() => attention.reload()} lastUpdated={attention.lastUpdated} /> : null}
            <AttentionTiles queues={queues} freshKeys={fresh} now={now} onVisit={onVisit} />
          </>
        ) : phase === "skeleton" ? (
          <SkeletonBlocks count={3} label="Loading what needs you" />
        ) : (
          <div className="adm-skeleton adm-skeleton--waiting" aria-busy="true" />
        )}
      </section>

      <div className="adm-home__grid">
        <div className="adm-home__main">
          <section className="adm-section" aria-labelledby="adm-today-title">
            <SectionHeading id="adm-today-title">Today&apos;s classes</SectionHeading>
            {loaded ? <TodaysClasses classes={attention.data?.live_today} /> : null}
          </section>
          <section className="adm-section" aria-labelledby="adm-activity-title">
            <SectionHeading id="adm-activity-title" action={<ActivityMoreLink />}>
              Recent activity
            </SectionHeading>
            {activity.error && !activity.data ? (
              <ErrorState error={activity.error} onRetry={() => activity.reload()} />
            ) : activity.data?.results?.length ? (
              <ActivityList entries={activity.data.results} now={now} compact />
            ) : activity.data ? (
              <p className="adm-quiet">Changes made by admins show up here.</p>
            ) : null}
          </section>
        </div>
        <aside className="adm-home__side" aria-label="Shortcuts">
          <section className="adm-section" aria-labelledby="adm-quick-title">
            <SectionHeading id="adm-quick-title">Quick actions</SectionHeading>
            <QuickActions />
          </section>
          {attention.data?.switches?.length ? (
            <section className="adm-section" aria-labelledby="adm-switches-title">
              <SectionHeading id="adm-switches-title">Platform switches</SectionHeading>
              <PlatformSwitches switches={attention.data.switches} />
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

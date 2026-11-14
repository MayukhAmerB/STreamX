// Student Console page "Calendar". OWNER: WS-ATTENDANCE (calendar).
// Month, week and agenda views of the student's live classes (agenda by
// default on phones, e.g. 390 px), Join when live, recordings afterwards,
// "Add to calendar" per class and a personal subscription link (revocable).
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../../kit/Button";
import { Card } from "../../kit/Card";
import { ArrowLeft, ArrowRight } from "../../kit/icons";

import { errorMessage, isAttendanceDisabledError, saveBlob } from "../attendance/attendanceApi";
import { InlineError, Loading, OffState, PageIntro } from "../attendance/AttendanceParts";
import { createMyFeed, fetchMyEvents, fetchMyFeed, revokeMyFeed } from "./calendarApi";
import {
  defaultView,
  eventIcs,
  formatMonthTitle,
  googleCalendarUrl,
  rangeForView,
  shiftAnchor,
  todayKey,
  weekKeys,
} from "./calendarModel";
import { AgendaView, EventCard, MonthView, ViewSwitch, WeekView } from "./CalendarParts";

const VIEW_KEY = "calendar:view";

function initialView() {
  if (typeof window === "undefined") return "agenda";
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    if (saved === "month" || saved === "week" || saved === "agenda") return saved;
  } catch {
    // storage unavailable: fall through
  }
  return defaultView(window.innerWidth);
}

function origin() {
  return typeof window !== "undefined" ? window.location.origin : "";
}

export function periodTitle(view, anchor) {
  if (view === "week") {
    const days = weekKeys(anchor);
    return `Week of ${Number(days[0].slice(8))} ${formatMonthTitle(days[0])}`;
  }
  if (view === "agenda") return "Upcoming and recent";
  return formatMonthTitle(anchor);
}

export function AddToCalendarPanel({ event, onClose }) {
  if (!event) return null;
  const download = () => {
    const blob = new Blob([eventIcs(event, { origin: origin() })], { type: "text/calendar;charset=utf-8" });
    saveBlob(blob, `class-${String(event.id).replace(/[^a-z0-9-]/gi, "")}.ics`);
  };
  return (
    <Card tone="raised" className="flex flex-col gap-3 p-4" role="dialog" aria-label={`Add ${event.title} to your calendar`}>
      <p className="text-sm text-white">Add “{event.title}” to your calendar</p>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="secondary" onClick={download}>
          Download .ics (Apple, Outlook)
        </Button>
        <Button asChild size="xs" variant="secondary">
          <a href={googleCalendarUrl(event, { origin: origin() })} target="_blank" rel="noopener noreferrer">
            Google Calendar
          </a>
        </Button>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </Card>
  );
}

export function SubscribePanel({ feed, busy, onCreate, onRevoke }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!feed?.url || !navigator?.clipboard) return;
    navigator.clipboard.writeText(feed.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Card tone="surface" className="flex flex-col gap-3 p-4">
      <h2 className="text-base font-semibold text-white">Subscribe in Google or Apple Calendar</h2>
      <p className="text-sm leading-6 text-white/65">
        Your classes appear in your own calendar and update automatically. Keep the link private: anyone with it can see your class times.
      </p>
      {feed?.active ? (
        <>
          <code className="block break-all rounded border border-white/10 bg-black p-2 text-xs text-white/80">{feed.url}</code>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="secondary" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button asChild size="xs" variant="secondary">
              <a href={feed.webcal_url}>Open in Apple Calendar</a>
            </Button>
            <Button asChild size="xs" variant="secondary">
              <a href={feed.google_url} target="_blank" rel="noopener noreferrer">
                Add to Google Calendar
              </a>
            </Button>
            <Button size="xs" variant="ghost" onClick={onCreate} disabled={busy}>
              New link
            </Button>
            <Button size="xs" variant="ghost" onClick={onRevoke} disabled={busy}>
              Turn off
            </Button>
          </div>
        </>
      ) : (
        <Button size="sm" variant="secondary" onClick={onCreate} disabled={busy} className="self-start">
          {busy ? "Creating…" : "Create my calendar link"}
        </Button>
      )}
    </Card>
  );
}

export default function CalendarPage() {
  const [view, setView] = useState(initialView);
  const [anchor, setAnchor] = useState(() => todayKey());
  const [events, setEvents] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(null);
  const [feed, setFeed] = useState(null);
  const [feedBusy, setFeedBusy] = useState(false);
  const today = todayKey();
  const range = useMemo(() => rangeForView(view, anchor), [view, anchor]);

  const fail = useCallback((err) => {
    if (isAttendanceDisabledError(err)) setState("off");
    else {
      setError(errorMessage(err, "Could not load your classes."));
      setState("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    fetchMyEvents(range)
      .then((data) => {
        if (cancelled) return;
        setEvents(data?.events || []);
        setState("ready");
      })
      .catch((err) => !cancelled && fail(err));
    return () => {
      cancelled = true;
    };
  }, [range, fail]);

  useEffect(() => {
    fetchMyFeed()
      .then(setFeed)
      .catch(() => {});
  }, []);

  const changeView = (next) => {
    setView(next);
    setSelected(null);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  };

  const feedAction = (action) => {
    setFeedBusy(true);
    action()
      .then(setFeed)
      .catch((err) => setError(errorMessage(err, "Could not update your calendar link.")))
      .finally(() => setFeedBusy(false));
  };

  if (state === "off") {
    return (
      <div className="flex flex-col gap-6 p-4 sm:p-6">
        <PageIntro title="Calendar" />
        <OffState title="The class calendar is switched off" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageIntro title="Calendar" actions={<ViewSwitch view={view} onChange={changeView} />}>
        Your live classes in India time (IST). Join from here when a class is live.
      </PageIntro>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="secondary" aria-label="Previous" onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))}>
          <ArrowLeft size={14} />
        </Button>
        <Button size="xs" variant="secondary" onClick={() => setAnchor(today)}>
          Today
        </Button>
        <Button size="xs" variant="secondary" aria-label="Next" onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))}>
          <ArrowRight size={14} />
        </Button>
        <h2 className="ml-2 text-base font-semibold text-white" aria-live="polite">
          {periodTitle(view, anchor)}
        </h2>
      </div>
      <InlineError>{error}</InlineError>
      {adding ? <AddToCalendarPanel event={adding} onClose={() => setAdding(null)} /> : null}
      {events === null ? (
        <Loading />
      ) : view === "agenda" ? (
        <AgendaView events={events} onAddToCalendar={setAdding} emptyText="No live classes in this period." />
      ) : (
        <>
          {view === "month" ? (
            <MonthView anchor={anchor} events={events} onSelect={setSelected} today={today} />
          ) : (
            <WeekView anchor={anchor} events={events} onSelect={setSelected} today={today} />
          )}
          {selected ? <EventCard event={selected} onAddToCalendar={setAdding} /> : null}
        </>
      )}
      <SubscribePanel
        feed={feed}
        busy={feedBusy}
        onCreate={() => feedAction(createMyFeed)}
        onRevoke={() => feedAction(revokeMyFeed)}
      />
    </div>
  );
}

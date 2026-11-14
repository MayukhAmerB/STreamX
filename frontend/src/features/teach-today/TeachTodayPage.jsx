// Teach > Today `/console/teach` (T1, plan §3.5). OWNER: WS-C.
// One row per job, each with a count and one action; the first job that is
// waiting carries the screen's one champagne button. Nothing waiting reads
// "All caught up". Data: GET /api/console/today/?workspace=teach.
import "../console-home/ConsoleHome.scss";

import { ArrowRight, CheckmarkFilled } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ErrorState } from "../app-shell/ui";
import { FeatureOffState } from "../capabilities";
import { LiveDot } from "../../site-kit/motion";
import { Eyebrow, KIND_ICONS, SkeletonBar } from "../console-home/HomeParts";
import { buildTeachRows, formatHubDate, isAllCaughtUp } from "../console-home/homeModel";
import useToday from "../console-home/useToday";

function TeachRow({ row, index }) {
  const Icon = KIND_ICONS[row.icon] || ArrowRight;
  const titleId = `ch-teach-${row.key}`;
  return (
    <li className={`ch-teach-row ch-enter${row.waiting ? "" : " ch-teach-row--quiet"}`} style={{ "--ch-i": index }}>
      <span className="ch-teach-row__icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <div className="ch-teach-row__text">
        <h2 id={titleId} className="ch-teach-row__title">
          {row.count != null ? <span className="ch-teach-row__count">{row.count}</span> : null}
          <span>{row.title}</span>
        </h2>
        <p className="ch-teach-row__desc">
          {row.live ? <LiveDot state="live" /> : null}
          <span>{row.text}</span>
        </p>
      </div>
      <div className="ch-teach-row__action">
        <Button
          as={Link}
          to={row.action.href}
          kind={row.accent ? "primary" : "tertiary"}
          size="md"
          renderIcon={ArrowRight}
          className={row.accent ? "ch-accent-button" : undefined}
          aria-describedby={titleId}
        >
          {row.action.label}
        </Button>
      </div>
    </li>
  );
}

function TeachSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="cds--visually-hidden">Loading what needs you</span>
      <ul className="ch-teach-list" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <li key={index} className="ch-teach-row">
            <span className="ch-teach-row__icon" />
            <span className="ch-teach-row__text">
              <SkeletonBar variant="kind" />
              <SkeletonBar variant="line" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Presentational Today (tests and the visual harness). */
export function TeachTodayView({ teach, loading = false, showSkeleton = false, error = "", errorCode = "", onRetry, updatedAt, now = new Date() }) {
  if (errorCode === "feature_disabled") return <FeatureOffState feature="teaching" reason={error} />;
  const rows = buildTeachRows(teach, now);
  const date = formatHubDate(now);
  return (
    <div className="ch-teach" data-template="t1">
      <header className="ch-greeting">
        {date ? <Eyebrow>{date}</Eyebrow> : null}
        <h1 className="ch-greeting__title">Today</h1>
        <p className="ch-greeting__lead">What needs you as a teacher.</p>
      </header>
      {error && !teach ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {loading && showSkeleton ? <TeachSkeleton /> : null}
      {teach ? (
        <>
          {error ? <ErrorState error={error} onRetry={onRetry} lastUpdated={updatedAt} /> : null}
          {isAllCaughtUp(rows) ? (
            <p className="ch-caught-up ch-enter" role="status">
              <CheckmarkFilled size={20} aria-hidden="true" />
              <span>All caught up. Nothing to grade or publish.</span>
            </p>
          ) : null}
          <ul className="ch-teach-list" aria-label="Your teaching jobs">
            {rows.map((row, index) => (
              <TeachRow key={row.key} row={row} index={index + 1} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export default function TeachTodayPage() {
  const today = useToday("teach");
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <TeachTodayView
      teach={today.data?.teach || null}
      loading={today.loading}
      showSkeleton={today.showSkeleton}
      error={today.error}
      errorCode={today.errorCode}
      onRetry={today.retry}
      updatedAt={today.updatedAt}
      now={now}
    />
  );
}

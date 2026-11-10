import "./Reports.scss";

import { ChevronRight, Report } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiData } from "../../utils/api";
import { listReportTasks } from "./reportsApi";
import { formatIst, getCountdown } from "./reportModel";
import useNow from "./useNow";

/** "Next report due …" card for the Console hub (presentational). */
export function ReportsDueTileView({ task, now = Date.now() }) {
  if (!task) return null;
  const countdown = getCountdown(task.due_at, now);
  const label = task.status === "returned_for_revision" ? "Report returned for changes" : "Next report due";
  return (
    <Link to={`/reports/tasks/${task.id}`} className="rpt-due-tile" aria-label={`${label}: ${task.title}, ${formatIst(task.due_at)}`}>
      <span className="rpt-due-tile__icon" aria-hidden="true">
        <Report size={20} />
      </span>
      <span className="rpt-due-tile__text">
        <span className="rpt-due-tile__label">{label}</span>
        <span className="rpt-due-tile__title">{task.title}</span>
        <span className="rpt-due-tile__meta">
          {formatIst(task.due_at)} · {countdown.text}
        </span>
      </span>
      <ChevronRight size={20} aria-hidden="true" className="rpt-due-tile__chevron" />
    </Link>
  );
}

/** Loads the student's next due report; renders nothing when there is none (or on error). */
export default function ReportsDueTile() {
  const [task, setTask] = useState(null);
  const now = useNow(60000);
  useEffect(() => {
    let cancelled = false;
    listReportTasks()
      .then((response) => {
        if (!cancelled) setTask(apiData(response, {})?.next_due || null);
      })
      .catch(() => {
        if (!cancelled) setTask(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return <ReportsDueTileView task={task} now={now} />;
}

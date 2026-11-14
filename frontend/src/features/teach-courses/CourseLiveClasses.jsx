// Course editor › Live classes (UI overhaul plan §3.5). OWNER: WS-D2.
// The live classes linked to this course; scheduling and hosting happen in
// Classes (WS-D1), so this tab points there.
import { ArrowRight, Video } from "@carbon/icons-react";
import { Link } from "react-router-dom";
import { EmptyState, StatusTag } from "../app-shell/ui";

const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

export function describeLiveClass(liveClass) {
  const parts = [];
  const days = Array.isArray(liveClass.schedule_days) ? liveClass.schedule_days : String(liveClass.schedule_days || "").split(",");
  const dayText = days
    .map((day) => String(day || "").trim())
    .filter(Boolean)
    .map((day) => DAY_NAMES[day.slice(0, 3).toLowerCase()] || day)
    .join(", ");
  if (dayText) parts.push(dayText);
  if (liveClass.class_duration_minutes) parts.push(`${liveClass.class_duration_minutes} min`);
  if (liveClass.month_number) parts.push(`Month ${liveClass.month_number}`);
  parts.push(`${liveClass.enrollment_count || 0} enrolled`);
  return parts.join(" · ");
}

export default function CourseLiveClasses({ course, classesHref }) {
  const items = course?.live_classes || [];
  return (
    <section className="tch-live" aria-labelledby="tch-live-title">
      <div className="tch-section-head">
        <h2 id="tch-live-title" className="tch-section-title">
          Live classes
        </h2>
        {items.length ? (
          <Link className="tch-link" to={classesHref}>
            Open Classes <ArrowRight size={16} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      {items.length ? (
        <ul className="tch-live__list">
          {items.map((liveClass) => (
            <li key={liveClass.id} className="tch-live__row">
              <span className="tch-live__text">
                <span className="tch-live__title">{liveClass.title}</span>
                <span className="tch-muted">{describeLiveClass(liveClass)}</span>
              </span>
              <StatusTag status={liveClass.is_active ? "scheduled" : "off"}>{liveClass.is_active ? "Active" : "Inactive"}</StatusTag>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={Video}
          title="No live classes are linked to this course."
          body="Live classes are set up and hosted in Classes."
          action={
            <Link className="tch-link" to={classesHref}>
              Open Classes <ArrowRight size={16} aria-hidden="true" />
            </Link>
          }
        />
      )}
    </section>
  );
}

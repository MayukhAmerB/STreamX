import {
  CheckmarkFilled,
  ChevronDown,
  CircleDash,
  Incomplete,
  Locked,
  PlayFilledAlt,
} from "@carbon/icons-react";
import { ProgressBar } from "@carbon/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { formatDuration, formatRunningTime } from "./formatters";

const STATUS_TEXT = {
  completed: "Completed",
  "in-progress": "In progress",
  "not-started": "Not started",
  locked: "Locked",
};

function LessonStatusIcon({ lesson }) {
  if (lesson.current && !lesson.locked) return <PlayFilledAlt size={16} aria-hidden="true" />;
  if (lesson.status === "completed") return <CheckmarkFilled size={16} aria-hidden="true" />;
  if (lesson.status === "locked") return <Locked size={16} aria-hidden="true" />;
  if (lesson.status === "in-progress") return <Incomplete size={16} aria-hidden="true" />;
  return <CircleDash size={16} aria-hidden="true" />;
}

/** One row in the lessons list: status icon, title, duration, progress. */
export function LessonItem({ lesson, onSelect }) {
  const meta = [];
  if (lesson.durationSeconds > 0) meta.push(formatDuration(lesson.durationSeconds));
  if (lesson.status === "in-progress" && lesson.percent > 0) meta.push(`${Math.round(lesson.percent)}% watched`);

  const classes = [
    "cp-lesson",
    `cp-lesson--${lesson.status}`,
    lesson.current ? "is-current" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      aria-current={lesson.current ? "true" : undefined}
      data-lesson-id={lesson.id}
      onClick={() => onSelect?.(lesson.lecture)}
    >
      <span className="cp-lesson__status">
        <LessonStatusIcon lesson={lesson} />
      </span>
      <span className="cp-lesson__body">
        <span className="cp-lesson__title">
          <span className="cp-lesson__number">{lesson.number}.</span> {lesson.title}
        </span>
        <span className="cp-lesson__meta">
          {meta.length ? <span>{meta.join(" · ")}</span> : null}
          {lesson.preview ? <span className="cp-lesson__badge">Preview</span> : null}
        </span>
        <span className="cds--visually-hidden">
          {", "}
          {lesson.current ? "Now playing, " : ""}
          {STATUS_TEXT[lesson.status]}
        </span>
      </span>
    </button>
  );
}

/** Collapsible module: "Module 2", title, "3/8 · 1 hr 20 min", lessons. */
export function OutlineModule({ module, expanded, onToggle, onSelect, headingLevel = 3 }) {
  const panelId = `cp-module-panel-${module.id}`;
  const Heading = `h${headingLevel}`;
  const runningTime = formatRunningTime(module.durationSeconds);
  return (
    <section className={`cp-module${expanded ? " is-expanded" : ""}`}>
      <Heading className="cp-module__heading">
        <button
          type="button"
          className="cp-module__toggle"
          aria-expanded={expanded ? "true" : "false"}
          aria-controls={panelId}
          onClick={() => onToggle?.(module.id)}
        >
          <span className="cp-module__text">
            <span className="cp-module__eyebrow">Module {module.index + 1}</span>
            <span className="cp-module__title">{module.title}</span>
            <span className="cp-module__meta">
              <span aria-hidden="true">
                {module.completedCount}/{module.totalCount}
              </span>
              <span className="cds--visually-hidden">
                {module.completedCount} of {module.totalCount} lessons completed
              </span>
              {runningTime ? <span aria-hidden="true"> · {runningTime}</span> : null}
            </span>
          </span>
          <ChevronDown size={16} className="cp-module__chevron" aria-hidden="true" />
        </button>
      </Heading>
      <div id={panelId} className="cp-module__panel" hidden={!expanded}>
        {module.lessons.length ? (
          <ul className="cp-lessons">
            {module.lessons.map((lesson) => (
              <li key={lesson.id}>
                <LessonItem lesson={lesson} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="cp-module__empty">No lessons in this module yet.</p>
        )}
      </div>
    </section>
  );
}

/** Which modules start open: the one with the current lesson (else the first). */
export function initialExpandedModules(outline) {
  const current = outline.modules.find((module) => module.containsCurrent) || outline.modules[0];
  return current ? [current.id] : [];
}

/**
 * Course outline: header with overall progress, then modules as an
 * accordion. Used in the desktop right rail and the phone "Lessons" tab.
 */
export default function CourseOutline({
  outline,
  courseId,
  courseTitle,
  currentLectureId,
  onSelect,
  headingId = "cp-outline-title",
  autoScrollToCurrent = false,
}) {
  const [expanded, setExpanded] = useState(() => new Set(initialExpandedModules(outline)));
  const listRef = useRef(null);

  // Open the module of the lesson that is now playing.
  const currentModuleId = outline.modules.find((module) => module.containsCurrent)?.id;
  useEffect(() => {
    if (currentModuleId === undefined) return;
    setExpanded((current) => (current.has(currentModuleId) ? current : new Set(current).add(currentModuleId)));
  }, [currentModuleId]);

  // Desktop rail: keep the current lesson visible inside the scrolling rail.
  useEffect(() => {
    if (!autoScrollToCurrent || currentLectureId === null || currentLectureId === undefined) return;
    const container = listRef.current;
    const item = container?.querySelector?.(`[data-lesson-id="${currentLectureId}"]`);
    if (!container || !item || typeof container.getBoundingClientRect !== "function") return;
    const containerBox = container.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    if (itemBox.top < containerBox.top || itemBox.bottom > containerBox.bottom) {
      container.scrollTop += itemBox.top - containerBox.top - containerBox.height / 3;
    }
  }, [autoScrollToCurrent, currentLectureId, expanded]);

  const toggle = (moduleId) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  return (
    <div className="cp-outline">
      <div className="cp-outline__header">
        <div className="cp-outline__heading-row">
          <h2 id={headingId} className="cp-outline__title">
            Course content
          </h2>
          {courseId ? (
            <Link className="cp-outline__live cds--link" to={`/courses/${courseId}/live`}>
              Live classes
            </Link>
          ) : null}
        </div>
        {courseTitle ? <p className="cp-outline__course">{courseTitle}</p> : null}
        <ProgressBar
          className="cp-outline__progress"
          label={`${outline.completed} of ${outline.total} lessons completed`}
          helperText={`${outline.percent}% complete`}
          value={outline.percent}
          max={100}
          size="small"
        />
      </div>
      <div className="cp-outline__modules" ref={listRef}>
        {outline.modules.map((module) => (
          <OutlineModule
            key={module.id}
            module={module}
            expanded={expanded.has(module.id)}
            onToggle={toggle}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

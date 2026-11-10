import { Tag } from "@carbon/react";
import { forwardRef } from "react";
import { formatDuration } from "./formatters";

/** Lesson title (the page's h1) with "Module 2 · Lesson 5 of 20 · 12:34". */
const LessonHeader = forwardRef(function LessonHeader({ lecture, position, total, locked, fullAccess }, ref) {
  if (!lecture) return null;
  const duration = Number(lecture.stream_duration_seconds || lecture.progress?.duration_seconds || 0);
  const meta = [];
  if (lecture.section_title) meta.push(lecture.section_title);
  if (position > 0 && total > 0) meta.push(`Lesson ${position} of ${total}`);
  if (duration > 0) meta.push(formatDuration(duration));

  return (
    <header className="cp-lesson-header">
      <h1 ref={ref} className="cp-lesson-header__title" tabIndex={-1}>
        {lecture.title || "Untitled lesson"}
      </h1>
      <div className="cp-lesson-header__meta">
        {meta.length ? <span>{meta.join(" · ")}</span> : null}
        {lecture.progress?.completed && !locked ? (
          <Tag type="green" size="sm" className="cp-lesson-header__tag">
            Completed
          </Tag>
        ) : null}
        {lecture.is_preview && !fullAccess ? (
          <Tag type="purple" size="sm" className="cp-lesson-header__tag">
            Free preview
          </Tag>
        ) : null}
        {locked ? (
          <Tag type="gray" size="sm" className="cp-lesson-header__tag">
            Locked
          </Tag>
        ) : null}
      </div>
    </header>
  );
});

export default LessonHeader;

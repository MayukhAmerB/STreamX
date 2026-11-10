import { Download, Keyboard } from "@carbon/icons-react";
import { Tag } from "@carbon/react";
import { forwardRef, useId, useState } from "react";
import { formatDuration, formatFileSize } from "./formatters";
import { PLAYER_SHORTCUTS } from "./playerShortcuts";

const CLAMP_CHARACTERS = 320;
const CLAMP_LINES = 5;

/** True when a description is long enough to collapse behind "Show more". */
export function shouldCollapseText(text) {
  const value = String(text || "");
  return value.length > CLAMP_CHARACTERS || value.split("\n").length > CLAMP_LINES;
}

/** Description with a YouTube-style "Show more / Show less" toggle. */
export function ExpandableText({ text, className = "" }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const collapsible = shouldCollapseText(text);
  return (
    <div className={`cp-expandable ${className}`.trim()}>
      <p id={id} className={`cp-expandable__text${collapsible && !expanded ? " is-clamped" : ""}`}>
        {text}
      </p>
      {collapsible ? (
        <button
          type="button"
          className="cp-text-button"
          aria-expanded={expanded ? "true" : "false"}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function ResourceList({ resources }) {
  return (
    <ul className="cp-resources">
      {resources.map((resource) => (
        <li key={resource.id}>
          <a className="cp-resource" href={resource.download_url} target="_blank" rel="noreferrer">
            <Download size={20} aria-hidden="true" className="cp-resource__icon" />
            <span className="cp-resource__text">
              <span className="cp-resource__title">{resource.title || resource.filename || "Download"}</span>
              <span className="cp-resource__meta">
                {[resource.filename, resource.file_size ? formatFileSize(resource.file_size) : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            {resource.file_extension ? (
              <Tag type="gray" size="sm" className="cp-resource__tag">
                {String(resource.file_extension).toUpperCase()}
              </Tag>
            ) : null}
            <span className="cds--visually-hidden"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Overview tab: what this lesson is about (expandable), the module's
 * description, downloads and the learner's own progress on the lesson.
 */
const OverviewPanel = forwardRef(function OverviewPanel(
  { lecture, descriptions, resources = [], progress, locked, showShortcuts = false },
  headingRef
) {
  const duration = Number(progress?.duration_seconds || lecture?.stream_duration_seconds || 0);
  const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent_complete || 0))));
  const resumeAt = progress?.completed ? 0 : Number(progress?.resume_position_seconds || 0);

  return (
    <div className="cp-overview">
      <section className="cp-overview__section" aria-labelledby="cp-panel-heading-overview">
        <h2 ref={headingRef} id="cp-panel-heading-overview" className="cp-panel-title" tabIndex={-1}>
          About this lesson
        </h2>
        {descriptions.primary ? (
          <ExpandableText text={descriptions.primary} />
        ) : (
          <p className="cp-muted">The instructor hasn&apos;t added a description for this lesson yet.</p>
        )}
      </section>

      {descriptions.moduleDescription ? (
        <section className="cp-overview__section" aria-labelledby="cp-overview-module">
          <h3 id="cp-overview-module" className="cp-section-title">
            About this module
          </h3>
          <ExpandableText text={descriptions.moduleDescription} />
        </section>
      ) : null}

      {!locked ? (
        <section className="cp-overview__section" aria-labelledby="cp-overview-progress">
          <h3 id="cp-overview-progress" className="cp-section-title">
            Your progress
          </h3>
          <dl className="cp-stats">
            <div className="cp-stats__item">
              <dt>Watched</dt>
              <dd>{progress?.completed ? "100%" : `${percent}%`}</dd>
            </div>
            <div className="cp-stats__item">
              <dt>{resumeAt > 0 ? "Resume at" : "Status"}</dt>
              <dd>{resumeAt > 0 ? formatDuration(resumeAt) : progress?.completed ? "Completed" : "Not started"}</dd>
            </div>
            <div className="cp-stats__item">
              <dt>Length</dt>
              <dd>{duration > 0 ? formatDuration(duration) : "—"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {resources.length ? (
        <section className="cp-overview__section" aria-labelledby="cp-overview-resources">
          <h3 id="cp-overview-resources" className="cp-section-title">
            Downloads
          </h3>
          <ResourceList resources={resources} />
        </section>
      ) : null}

      {showShortcuts ? (
        <details className="cp-shortcuts">
          <summary className="cp-shortcuts__summary">
            <Keyboard size={16} aria-hidden="true" />
            Keyboard shortcuts
          </summary>
          <dl className="cp-shortcuts__list">
            {PLAYER_SHORTCUTS.map((shortcut) => (
              <div key={shortcut.label} className="cp-shortcuts__row">
                <dt>
                  {shortcut.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </dt>
                <dd>{shortcut.label}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
});

export default OverviewPanel;

// Student identity header (owner rule). OWNER: identity-exam.
// Roll number -> real name -> handle (with the most recent handle when it
// changed) -> stats, then the screen's own content. Auto-filled and
// read-only: students never type their identity on a report or an exam.
import { Locked } from "@carbon/icons-react";
import { useCallback, useEffect, useId, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import { getMyIdentity } from "./identityApi";
import { EMPTY, identityFields, identityStats } from "./identityModel";
import "./identity.css";

/** Presentational: render a block from any API (`identity` field) in the owner's order. */
export function StudentIdentityHeader({ identity, loading = false, error = "", onRetry, eyebrow = "Your identity", compact = false }) {
  const titleId = `sid-${useId().replace(/:/g, "")}`;
  if (loading) {
    return (
      <section className="sid sid--loading" aria-busy="true" aria-label="Loading your identity">
        <div className="sid__skeleton" />
      </section>
    );
  }
  if (error) {
    return (
      <section className="sid" aria-label="Student identity">
        <p className="sid__error" role="status">
          Your identity could not be loaded. {error}{" "}
          {onRetry ? (
            <button type="button" className="sid__retry" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </p>
      </section>
    );
  }
  if (!identity) return null;
  const fields = identityFields(identity);
  const stats = identityStats(identity.stats);
  return (
    <section className={`sid${compact ? " sid--compact" : ""}`} aria-labelledby={titleId} data-testid="student-identity">
      <header className="sid__head">
        <h2 id={titleId} className="sid__eyebrow">
          {eyebrow}
        </h2>
        <span className="sid__lock">
          <Locked size={14} aria-hidden="true" />
          Auto-filled · read-only
        </span>
      </header>
      <dl className="sid__grid">
        {fields.map((field) => (
          <div key={field.key} className="sid__cell" data-field={field.key}>
            <dt className="sid__label">{field.label}</dt>
            <dd className={`sid__value${field.mono ? " sid__value--mono" : ""}`}>{field.value || EMPTY}</dd>
            {field.note ? <dd className="sid__note">{field.note}</dd> : null}
          </div>
        ))}
      </dl>
      {identity.stats ? (
        <dl className="sid__stats" aria-label="Your stats">
          {stats.map((cell) => (
            <div key={cell.key} className="sid__stat" data-stat={cell.key}>
              <dt className="sid__label">{cell.label}</dt>
              <dd className="sid__stat-value">{cell.value}</dd>
              {cell.note ? <dd className="sid__note">{cell.note}</dd> : null}
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** The signed-in student's own header (GET /api/me/identity/). */
export default function MyIdentityHeader({ courseId, eyebrow, compact }) {
  const [state, setState] = useState({ data: null, loading: true, error: "" });
  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    getMyIdentity(courseId)
      .then((response) => setState({ data: apiData(response, null), loading: false, error: "" }))
      .catch((error) => setState({ data: null, loading: false, error: apiMessage(error, "Please try again.") }));
  }, [courseId]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <StudentIdentityHeader
      identity={state.data}
      loading={state.loading}
      error={state.error}
      onRetry={load}
      eyebrow={eyebrow}
      compact={compact}
    />
  );
}

// Lecture questions as a T2 list (UI overhaul plan §3.5, §4.3). OWNER: WS-D2.
// Exported for the Admin › Community "Questions" tab (WS-G) and used by the
// /lecture-questions page. Read-only today: status changes happen in the
// back office (the API has no write endpoint yet).
import "./Questions.scss";

import { ArrowRight, Chat, CheckmarkFilled, Time, View } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, PageSkeleton, Toolbar } from "../app-shell/ui";
import { listAdminLectureQuestions } from "../../api/courses";
import { apiData, apiMessage } from "../../utils/api";

export const QUESTION_FILTERS = Object.freeze([
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "reviewed", label: "Reviewed" },
  { key: "answered", label: "Answered" },
]);

const STATUS_META = {
  new: { label: "New", icon: Time, tone: "new" },
  reviewed: { label: "Reviewed", icon: View, tone: "reviewed" },
  answered: { label: "Answered", icon: CheckmarkFilled, tone: "answered" },
};

export function QuestionStatus({ status, label }) {
  const meta = STATUS_META[status] || { label: label || status, icon: Time, tone: "new" };
  const Icon = meta.icon;
  return (
    <span className={`qst-status qst-status--${meta.tone}`} data-status={status}>
      <Icon size={16} aria-hidden="true" />
      {label || meta.label}
    </span>
  );
}

export function formatAsked(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** Normalises the list response (plain list or `{ results, pagination }`). */
export function questionsPage(payload) {
  if (Array.isArray(payload)) return { items: payload, pagination: null };
  return { items: payload?.results || [], pagination: payload?.pagination || null };
}

export function QuestionCard({ question }) {
  return (
    <li className="qst-card">
      <div className="qst-card__head">
        <span className="qst-card__who">
          <span className="qst-card__name">{question.student_name || question.student_email || "A student"}</span>
          {question.student_name && question.student_email ? <span className="qst-muted">{question.student_email}</span> : null}
        </span>
        <QuestionStatus status={question.status} label={question.status_label} />
      </div>
      <p className="qst-card__where">
        {question.course_title || "Course"} · {question.lecture_title || "Lecture"}
      </p>
      <p className="qst-card__question">{question.question}</p>
      <div className="qst-card__foot">
        <span className="qst-muted">Asked {formatAsked(question.created_at)}</span>
        {question.course_id ? (
          <Link className="qst-link" to={`/learn/${question.course_id}`}>
            Open the lecture <ArrowRight size={16} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Search + status chips + the question cards, paged 50 at a time.
 * `initialStatus` picks the first chip (e.g. "new" for an attention queue).
 */
export default function QuestionsList({ initialStatus = "all", pageSize = 50 }) {
  const [status, setStatus] = useState(initialStatus);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ items: [], pagination: null, loading: true, error: "" });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(query.trim());
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: "" }));
    listAdminLectureQuestions({ paginate: 1, page, page_size: pageSize, status, search })
      .then((response) => alive && setState({ ...questionsPage(apiData(response, [])), loading: false, error: "" }))
      .catch((error) => alive && setState({ items: [], pagination: null, loading: false, error: apiMessage(error, "Please try again.") }));
    return () => {
      alive = false;
    };
  }, [status, search, page, pageSize, attempt]);

  const total = state.pagination?.total ?? state.items.length;
  const chips = useMemo(
    () =>
      QUESTION_FILTERS.map((item) => ({
        key: item.key,
        label: item.label,
        active: status === item.key,
        count: status === item.key && !state.loading ? total : undefined,
        onClick: () => {
          setPage(1);
          setStatus(item.key);
        },
      })),
    [status, state.loading, total]
  );

  let body;
  if (state.loading && !state.items.length) body = <PageSkeleton label="Loading questions" count={3} />;
  else if (state.error) body = <ErrorState error={`Couldn't load questions. ${state.error}`} onRetry={() => setAttempt((value) => value + 1)} />;
  else if (!state.items.length) {
    body = (
      <EmptyState
        icon={Chat}
        title={search || status !== "all" ? "No questions match this view." : "No questions yet."}
        body={search || status !== "all" ? undefined : "Students ask from the lecture page; their questions land here."}
        action={
          search || status !== "all" ? (
            <Button
              kind="tertiary"
              size="md"
              onClick={() => {
                setQuery("");
                setSearch("");
                setStatus("all");
              }}
            >
              Show all questions
            </Button>
          ) : null
        }
      />
    );
  } else {
    body = (
      <ul className="qst-list" aria-busy={state.loading || undefined}>
        {state.items.map((question) => (
          <QuestionCard key={question.id} question={question} />
        ))}
      </ul>
    );
  }

  const pagination = state.pagination;
  return (
    <div className="qst">
      <Toolbar search={{ value: query, onChange: setQuery, placeholder: "Search student, course, lecture or question" }} chips={chips} />
      {body}
      {pagination && (pagination.has_previous || pagination.has_next) ? (
        <nav className="qst-pager" aria-label="Pages">
          <Button kind="ghost" size="md" disabled={!pagination.has_previous} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            Previous
          </Button>
          <span className="qst-muted">
            Page {pagination.page} of {pagination.pages || 1}
          </span>
          <Button kind="ghost" size="md" disabled={!pagination.has_next} onClick={() => setPage((value) => value + 1)}>
            Next
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

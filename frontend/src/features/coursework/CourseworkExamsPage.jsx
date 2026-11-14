// Coursework › Exams `/coursework/exams` (plan §3.4). OWNER: WS-C.
// The student's open or next exam (from /api/ctf/eligibility/) with one
// action: "Start exam" opens labs. When the student cannot sit an exam the
// server's reason is shown with its next step, never an empty list.
import { Flag, Launch } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { siteBrand } from "../../config/siteBrand";
import { apiData, apiMessage } from "../../utils/api";
import { BRAND_ALSYED, LABS_URL } from "../app-shell/navConfig";
import { EmptyState, ErrorState, PageSkeleton, StatusTag } from "../app-shell/ui";
import { formatIstMoment } from "../exams/examModel";
import { getExamEligibility } from "../exams/examsApi";
import MyIdentityHeader from "../identity/StudentIdentityHeader";
import CourseworkHeader from "./CourseworkHeader";

export const LABS_EXAM_URL = `${LABS_URL}/#exam`;

/** Cards for the eligibility payload: the open exam first, then the next one. */
export function examCards(eligibility) {
  if (!eligibility) return [];
  const cards = [];
  const exam = eligibility.exam;
  if (eligibility.enabled && exam?.window === "open") {
    cards.push({ key: exam.slug, status: "open", title: exam.title?.en || exam.slug, meta: exam.closes_at ? `Closes ${formatIstMoment(exam.closes_at)}` : "Open now", action: "Start exam" });
  } else if (exam?.window === "not_open" && exam.opens_at) {
    cards.push({ key: exam.slug, status: "scheduled", title: exam.title?.en || exam.slug, meta: `Opens ${formatIstMoment(exam.opens_at)}`, action: "Open labs" });
  }
  const next = eligibility.next_exam;
  if (next?.opens_at && !cards.some((card) => card.key === next.slug)) {
    cards.push({ key: next.slug, status: "scheduled", title: next.title?.en || next.slug, meta: `Opens ${formatIstMoment(next.opens_at)}`, action: null });
  }
  return cards;
}

function ExamCard({ card, accent }) {
  return (
    <article className="cw-exam" aria-labelledby={`cw-exam-${card.key}`}>
      <span className="cw-exam__icon" aria-hidden="true">
        <Flag size={24} />
      </span>
      <div className="cw-exam__text">
        <p className="cw-exam__label">
          <StatusTag status={card.status} />
        </p>
        <h2 id={`cw-exam-${card.key}`} className="cw-exam__title">
          {card.title}
        </h2>
        <p className="cw-exam__meta">{card.meta}</p>
      </div>
      {card.action ? (
        <Button
          as="a"
          href={LABS_EXAM_URL}
          target="_blank"
          rel="noopener noreferrer"
          kind={accent ? "primary" : "tertiary"}
          className={accent ? "cw-accent" : undefined}
          renderIcon={Launch}
        >
          {card.action}
          <span className="cds--visually-hidden"> (opens labs in a new tab)</span>
        </Button>
      ) : null}
    </article>
  );
}

/** Presentational (tests and the visual harness). */
export function CourseworkExamsView({ eligibility, loading = false, error = "", onRetry, identity = null }) {
  const cards = examCards(eligibility);
  const action = eligibility?.action;
  return (
    <>
      <CourseworkHeader active="exams" />
      <div className="cw-page">
        {/* Owner rule: the candidate's roll number, real name, handle and stats come first. */}
        {identity}
        {loading ? <PageSkeleton label="Loading your exams" count={1} /> : null}
        {!loading && error ? <ErrorState error={error} onRetry={onRetry} /> : null}
        {!loading && !error && cards.length
          ? cards.map((card, index) => <ExamCard key={card.key} card={card} accent={index === 0 && card.status === "open"} />)
          : null}
        {!loading && !error && eligibility && !cards.length ? (
          <EmptyState
            icon={Flag}
            title={eligibility.message || "No exam is open right now."}
            action={
              action?.url ? (
                <Button as={Link} to={new URL(action.url, "http://x").pathname} kind="tertiary">
                  {action.label}
                </Button>
              ) : (
                <Button as={Link} to="/reports" kind="ghost">
                  Go to this week
                </Button>
              )
            }
          />
        ) : null}
      </div>
    </>
  );
}

export default function CourseworkExamsPage() {
  const enabled = siteBrand.id === BRAND_ALSYED;
  const [state, setState] = useState({ data: null, loading: enabled, error: "" });
  const load = useCallback(() => {
    if (!enabled) return;
    setState((current) => ({ ...current, loading: true, error: "" }));
    getExamEligibility()
      .then((response) => setState({ data: apiData(response, null), loading: false, error: "" }))
      .catch((error) => setState({ data: null, loading: false, error: apiMessage(error, "Please try again.") }));
  }, [enabled]);
  useEffect(() => {
    load();
  }, [load]);
  if (!enabled) {
    return (
      <CourseworkExamsView
        eligibility={{ enabled: false, message: "Exams are not available on this site.", action: null, exam: null, next_exam: null }}
      />
    );
  }
  return (
    <CourseworkExamsView
      eligibility={state.data}
      loading={state.loading}
      error={state.error}
      onRetry={load}
      identity={<MyIdentityHeader eyebrow="Exam candidate" />}
    />
  );
}

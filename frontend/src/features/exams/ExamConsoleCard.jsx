import "./Exams.scss";

import { ChevronRight, Flag } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { siteBrand } from "../../config/siteBrand";
import { useAuth } from "../../hooks/useAuth";
import { apiData } from "../../utils/api";
import { BRAND_ALSYED, LABS_URL } from "../app-shell/navConfig";
import { studentExamCard } from "./examModel";
import { getExamEligibility, getExamSummary } from "./examsApi";

export const LABS_EXAM_URL = `${LABS_URL}/#exam`;

/** "Exam open now" / "Next exam" card (presentational; null renders nothing). */
export function ExamConsoleCardView({ card }) {
  if (!card) return null;
  const content = (
    <>
      <span className="exm-card-tile__icon" aria-hidden="true">
        <Flag size={20} />
      </span>
      <span className="exm-card-tile__text">
        <span className="exm-card-tile__label">{card.label}</span>
        <span className="exm-card-tile__title">{card.title}</span>
        <span className="exm-card-tile__meta">{card.meta}</span>
      </span>
      <ChevronRight size={20} aria-hidden="true" />
    </>
  );
  const className = `exm-card-tile${card.tone === "open" ? " exm-card-tile--open" : ""}`;
  if (card.to) {
    return (
      <Link to={card.to} className={className} aria-label={`${card.label}: ${card.title}, ${card.meta}`}>
        {content}
      </Link>
    );
  }
  return (
    <a href={card.href} className={className} target="_blank" rel="noopener noreferrer" aria-label={`${card.label}: ${card.title}, ${card.meta} (opens labs)`}>
      {content}
    </a>
  );
}

/** Staff: exams open now (with how many students are in them). */
export function staffExamCard(summary) {
  const open = summary?.open || [];
  if (open.length) {
    const active = open.reduce((sum, exam) => sum + (exam.active || 0), 0);
    return {
      tone: "open",
      label: open.length === 1 ? "Exam open now" : `${open.length} exams open now`,
      title: open.map((exam) => exam.title).join(", "),
      meta: `${active} student(s) answering right now`,
      to: open.length === 1 ? `/console/exams/${open[0].slug}` : "/console/exams",
    };
  }
  const next = summary?.scheduled?.[0];
  if (next) {
    return { tone: "upcoming", label: "Exam scheduled", title: next.title, meta: "Publishes itself at its opening time", to: `/console/exams/${next.slug}` };
  }
  return null;
}

/** Loads the card for the Console hub. Labs (and so exams) exist for the Al Syed brand only. */
export default function ExamConsoleCard() {
  // Null outside an AuthProvider (static renders of the hub in tests).
  const isAdmin = Boolean(useAuth()?.isAdmin);
  const [card, setCard] = useState(null);
  const enabled = siteBrand.id === BRAND_ALSYED;
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const request = isAdmin ? getExamSummary() : getExamEligibility();
    request
      .then((response) => {
        if (cancelled) return;
        const data = apiData(response, null);
        setCard(isAdmin ? staffExamCard(data) : studentExamCard(data, LABS_EXAM_URL));
      })
      .catch(() => !cancelled && setCard(null));
    return () => {
      cancelled = true;
    };
  }, [enabled, isAdmin]);
  return <ExamConsoleCardView card={card} />;
}

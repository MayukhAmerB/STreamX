// NotFoundState (UI overhaul plan §2.5, §2.7, Appendix A.5). OWNER: WS-A.
// A 404 inside the Console: one icon, one sentence and a way back, never
// "Retry" and never a silent redirect to the website.
import { ArrowLeft, SearchLocate } from "@carbon/icons-react";
import { useId } from "react";
import { Link } from "react-router-dom";
import "./overhaul.scss";

export default function NotFoundState({ title = "This page does not exist", backHref = "/console", backLabel = "Back to Home", body, icon: Icon = SearchLocate }) {
  const titleId = useId();
  return (
    <section className="sc-state" aria-labelledby={titleId}>
      <Icon size={32} aria-hidden="true" className="sc-state__icon" />
      <h1 id={titleId} className="sc-state__title">
        {title}
      </h1>
      <p className="sc-state__body">{body || "The link may be old, or the page may have moved."}</p>
      <Link className="sc-state__action" to={backHref}>
        <ArrowLeft size={16} aria-hidden="true" />
        <span>{backLabel}</span>
      </Link>
    </section>
  );
}

// Catalogue card (PHILOSOPHY §2.7): one stretched link per card, title + meta
// eyebrow, status pill over the line art, a 3-line summary and a footer row
// with facts and the action word. Hover/focus inverts the card (M3).
import { Link as RouterLink } from "react-router-dom";

import LineArt, { lineArtFor } from "./LineArt";
import { ArrowUpRightIcon, cx, StatusPill } from "./primitives";
import { courseStatus, hoursLabel, levelLabel, moduleCount } from "./tiers";

export function CardShell({ href, external = false, title, eyebrow, status, art, description, facts, action, label, disabled = false, children, className }) {
  const linkProps = external ? { href, target: "_blank", rel: "noopener noreferrer" } : null;
  const titleNode = disabled || !href ? (
    title
  ) : external ? (
    <a className="hp-card__link" {...linkProps} aria-label={label}>
      {title}
      <span className="hp-sr"> (opens in a new tab)</span>
    </a>
  ) : (
    <RouterLink className="hp-card__link" to={href} aria-label={label}>
      {title}
    </RouterLink>
  );
  return (
    <article className={cx("hp-card", href && !disabled && "hp-card--link", disabled && "hp-card--disabled", className)}>
      <div className="hp-card__head">
        <div>
          <h3 className="hp-card__title">{titleNode}</h3>
          {eyebrow ? <p className="hp-eyebrow hp-card__eyebrow">{eyebrow}</p> : null}
        </div>
        {href && !disabled ? <ArrowUpRightIcon /> : null}
      </div>
      <div className="hp-card__art">
        {status ? <span className="hp-card__pill">{status}</span> : null}
        <LineArt name={art} />
      </div>
      <div className="hp-card__foot">
        {description ? <p className="hp-card__desc">{description}</p> : null}
        {children}
        <div className="hp-card__row">
          <span>{facts}</span>
          {action ? <span className="hp-card__action">{action}</span> : null}
        </div>
      </div>
    </article>
  );
}

/** A course from the API as a catalogue card (links to /courses/:id, Pentesting included). */
export function CourseCatalogCard({ course }) {
  const id = Number(course?.id || 0);
  const title = course?.card_title || course?.title || "Untitled course";
  const status = courseStatus(course);
  const modules = moduleCount(course);
  const hours = hoursLabel(course);
  const facts = [modules ? `${modules} module${modules === 1 ? "" : "s"}` : "", hours].filter(Boolean).join(" · ");
  const format = course?.duration && /self/i.test(course.duration) ? "Self-paced" : course?.category === "osint" ? "Live cohort" : "";
  return (
    <CardShell
      href={id > 0 ? `/courses/${id}` : null}
      title={title}
      label={`${title}: ${status.label}. View course`}
      eyebrow={[levelLabel(course?.level), format].filter(Boolean).join(" · ")}
      status={<StatusPill kind={status.kind}>{status.label}</StatusPill>}
      art={lineArtFor(course)}
      description={course?.card_summary || course?.card_subtitle || course?.description || ""}
      facts={facts || " "}
      action={status.kind === "soon" ? "Browse outline" : "View course"}
    />
  );
}

/** A lab of labs.alsyedinitiative.com (external deep link to its tab). */
export function LabCatalogCard({ lab, access, href }) {
  return (
    <CardShell
      href={href}
      external
      title={`${lab.index} · ${lab.title}`}
      label={`${lab.title} lab (${access.label}). Open lab`}
      eyebrow={[lab.difficulty, lab.challenges ? `${lab.challenges} challenges` : lab.case].filter(Boolean).join(" · ")}
      status={<StatusPill kind={access.kind === "open" ? "open" : "members"}>{access.label}</StatusPill>}
      art={lab.art}
      description={lab.summary}
      facts={access.note}
      action="Open lab ↗"
    />
  );
}

/** Tier section: header (title, summary, count) + hairline grid of cards. */
export function TierSection({ id, kicker, title, summary, count, countLabel = "course", children, gridClassName = "hp-grid--3" }) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section id={id} className="hp-tier" aria-labelledby={headingId}>
      <div className="hp-tier__head">
        <div>
          {kicker ? <p className="hp-eyebrow hp-tier__kicker">{kicker}</p> : null}
          <h3 id={headingId} className="hp-tier__title">
            {title}
          </h3>
          {summary ? <p className="hp-tier__summary">{summary}</p> : null}
        </div>
        {typeof count === "number" ? (
          <p className="hp-tier__count">
            {count} {countLabel}
            {count === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>
      <ul className={cx("hp-grid hp-tier__body", gridClassName)}>{children}</ul>
    </section>
  );
}

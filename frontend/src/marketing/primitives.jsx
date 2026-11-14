// Marketing primitives (PHILOSOPHY.md §2.7, §3.3): small, dependency-free
// building blocks for the public pages. Kept free of Radix/DOM-only APIs so
// they render in the link-parity tree renderer and on the server.
import { Fragment, useId } from "react";
import { Link as RouterLink } from "react-router-dom";

export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

const isExternal = (href) => /^(https?:|mailto:|tel:)/.test(String(href || ""));

/* ------------------------------------------------------------------ icons */

const iconProps = { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" };

export function ArrowRightIcon({ className = "hp-btn__arrow" }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "hp-btn__arrow" }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

export function ArrowUpRightIcon({ className = "hp-card__corner" }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...iconProps} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function CheckIcon({ className }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function DashIcon({ className }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4.5 8h7" />
    </svg>
  );
}

export function ClockIcon({ className }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

export function LockIcon({ className }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.25" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function InfoIcon({ className }) {
  return (
    <svg {...iconProps} className={className} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.9v.1" />
    </svg>
  );
}

export function CheckCircleIcon({ className }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="m5 8.2 2 2 4-4.4" fill="none" stroke="#000" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HalfCircleIcon({ className }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" />
    </svg>
  );
}

export function OpenCircleIcon({ className }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2.2 2.2" />
    </svg>
  );
}

/* ------------------------------------------------------------------ type */

/** One handwritten accent word (Handlee). `accent` makes it golden white (landing hero only). */
export function Hand({ children, accent = false }) {
  return <span className={cx("hp-hand", accent && "hp-hand--accent")}>{children}</span>;
}

/** The tilted handwritten full stop (PHILOSOPHY §2.2 recipe). */
export function HandPeriod() {
  return (
    <span className="hp-hand-period" aria-hidden="true">
      .
    </span>
  );
}

/**
 * Display headline. `lines` are rendered one per block line; `periods`
 * appends the handwritten period after every line (the one Handlee touch).
 * Screen readers get the plain text with real full stops.
 */
export function DisplayHeading({ as: Element = "h2", id, lines, periods = false, size, className, children }) {
  return (
    <Element id={id} className={cx("hp-display", size === "xl" && "hp-display--xl", size === "hero" && "hp-display--hero", className)}>
      {Array.isArray(lines)
        ? lines.map((line, index) => (
            <Fragment key={index}>
              <span className="hp-display__line">
                {line}
                {periods ? (
                  <>
                    <HandPeriod />
                    <span className="hp-sr">.</span>
                  </>
                ) : null}
              </span>
              {index < lines.length - 1 ? " " : null}
            </Fragment>
          ))
        : children}
    </Element>
  );
}

export function Eyebrow({ children, accent = false, as: Element = "p", className }) {
  return <Element className={cx("hp-eyebrow", accent && "hp-eyebrow--accent", className)}>{children}</Element>;
}

/** "TRACK — TIER" kicker: first part in golden white, a short rule, the rest subtle. */
export function Kicker({ lead, rest, className }) {
  return (
    <p className={cx("hp-kicker", className)}>
      <span className="hp-kicker__lead">{lead}</span>
      {rest ? (
        <>
          <span className="hp-kicker__dash" aria-hidden="true" />
          <span>{rest}</span>
        </>
      ) : null}
    </p>
  );
}

export function Tagline({ children, as: Element = "p" }) {
  return <Element className="hp-tagline">{children}</Element>;
}

/* ------------------------------------------------------------------ buttons */

/**
 * A link styled as a button (primary | secondary | accent | ghost). Internal
 * paths use the router; external ones open in a new tab with a hidden note.
 */
export function ButtonLink({ to, variant = "primary", size, block = false, arrow = false, external, className, children, ...rest }) {
  const classes = cx("hp-btn", `hp-btn--${variant}`, size && `hp-btn--${size}`, block && "hp-btn--block", className);
  const content = (
    <>
      {children}
      {arrow === "external" ? <ArrowUpRightIcon className="hp-btn__arrow" /> : arrow ? <ArrowRightIcon /> : null}
    </>
  );
  if (String(to || "").startsWith("#")) {
    return (
      <a href={to} className={classes} {...rest}>
        {content}
      </a>
    );
  }
  if (external ?? isExternal(to)) {
    const mail = String(to).startsWith("mailto:");
    return (
      <a href={to} className={classes} target={mail ? undefined : "_blank"} rel={mail ? undefined : "noopener noreferrer"} {...rest}>
        {content}
        {mail ? null : <span className="hp-sr"> (opens in a new tab)</span>}
      </a>
    );
  }
  return (
    <RouterLink to={to} className={classes} {...rest}>
      {content}
    </RouterLink>
  );
}

/**
 * Disabled-with-reason (BUILD_PLAN §1.4): looks like the button, never
 * navigates or submits, stays focusable, and the visible reason is its
 * accessible description.
 */
export function DisabledAction({ label, reason, variant = "primary", size, block = false, className, icon = "clock", reasonClassName }) {
  const reasonId = useId();
  return (
    <span className={cx("hp-disabled", block && "hp-disabled--block", className)}>
      <span
        role="button"
        aria-disabled="true"
        tabIndex={0}
        aria-describedby={reason ? reasonId : undefined}
        className={cx("hp-btn", `hp-btn--${variant}`, size && `hp-btn--${size}`, block && "hp-btn--block")}
        data-disabled-action="true"
      >
        {icon === "lock" ? <LockIcon className="hp-btn__arrow" /> : <ClockIcon className="hp-btn__arrow" />}
        {label}
      </span>
      {reason ? (
        <span id={reasonId} className={cx("hp-reason", reasonClassName)}>
          {reason}
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ status */

const STATUS_ICONS = {
  open: CheckCircleIcon,
  free: null,
  soon: ClockIcon,
  closed: DashIcon,
  locked: LockIcon,
  members: LockIcon,
  progress: HalfCircleIcon,
  planned: OpenCircleIcon,
  live: null,
};

/** Icon + word + luminance, never hue (BUILD_PLAN §1.2). */
export function StatusPill({ kind = "open", children, className }) {
  const Icon = STATUS_ICONS[kind];
  return (
    <span className={cx("hp-status", `hp-status--${kind}`, className)} data-status={kind}>
      {kind === "live" ? <span className="hp-live-dot" aria-hidden="true" /> : null}
      {Icon ? <Icon /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ blocks */

/** A thin divider stat strip: 2 columns at 390, N columns from 640px. */
export function StatStrip({ items, wide = false, className, label = "Key figures" }) {
  const rows = (items || []).filter((item) => item && (item.value || item.value === 0));
  if (!rows.length) return null;
  return (
    <dl className={cx("hp-stats", wide && "hp-stats--wide", className)} style={{ "--hp-stats-n": rows.length }} aria-label={label}>
      {rows.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ eyebrow, title, children, accent = false, className, icon = "info" }) {
  return (
    <div className={cx("hp-notice", accent && "hp-notice--accent", className)} role="note">
      {icon === "clock" ? <ClockIcon className="hp-notice__icon" /> : <InfoIcon className="hp-notice__icon" />}
      <div>
        {eyebrow ? <p className="hp-eyebrow">{eyebrow}</p> : null}
        {title ? <p className="hp-notice__title">{title}</p> : null}
        {children ? <div className="hp-notice__body">{children}</div> : null}
      </div>
    </div>
  );
}

/** Section heading: eyebrow, h2 and lead; `aside` (e.g. a count) sits on the right when split. */
export function SectionHead({ id, eyebrow, title, lead, align = "left", split = false, aside, as: Heading = "h2", headingClassName = "hp-h2" }) {
  return (
    <div className={cx("hp-section-head", align === "center" && "hp-section-head--center", split && "hp-section-head--split")}>
      <div className="hp-section-head__copy">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Heading id={id} className={headingClassName}>
          {title}
        </Heading>
        {lead ? <p className="hp-lead">{lead}</p> : null}
      </div>
      {aside ? <div className="hp-tier__count">{aside}</div> : null}
    </div>
  );
}

export function CheckList({ items }) {
  return (
    <ul className="hp-checks">
      {items.map((item) => (
        <li key={item.lead || item.text}>
          <CheckIcon />
          <span>
            {item.lead ? <strong>{item.lead} </strong> : null}
            {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** FAQ as native <details> (keyboard and screen-reader friendly, no JS). */
export function FaqList({ items, id, className }) {
  return (
    <div className={cx("hp-faq", className)} id={id}>
      {items.map((item) => (
        <details key={item.q}>
          <summary>
            <span>{item.q}</span>
            <ChevronDownIcon />
          </summary>
          <div className="hp-faq__answer">{item.a}</div>
        </details>
      ))}
    </div>
  );
}

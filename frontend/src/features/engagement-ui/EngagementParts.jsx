// Engagement building blocks: progress ring, badge medal (our own line art),
// XP / streak chips and the stat strip. OWNER: WS-LEARN (console-student).
// Palette law: white, greys and golden white only; tiers and states are told
// apart by word + pips + solid/dashed strokes, never by hue.
import { useId } from "react";
import { badgeGlyph, formatXp, tierInfo } from "./engagementModel";

/** Circular progress (SVG). `value` 0..100. The number is real text for screen readers. */
export function ProgressRing({ value = 0, size = 56, stroke = 4, label, tone = "accent", children, className = "" }) {
  const clamped = Math.max(0, Math.min(100, Number(value) || 0));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  return (
    <span
      className={`eg-ring eg-ring--${tone} ${className}`}
      style={{ inlineSize: size, blockSize: size }}
      role="img"
      aria-label={label ? `${label}: ${Math.round(clamped)}%` : `${Math.round(clamped)}%`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle className="eg-ring__track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} fill="none" />
        <circle
          className="eg-ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children ? (
        <span className="eg-ring__center" aria-hidden="true">
          {children}
        </span>
      ) : null}
    </span>
  );
}

const GLYPHS = {
  lecture: <path d="M10 8.5v7l6-3.5-6-3.5Z" />,
  report: (
    <>
      <path d="M8.5 6.5h5l2.5 2.5v8.5h-7.5Z" />
      <path d="M10.5 11.5h3.5M10.5 14h3.5" />
    </>
  ),
  exam: (
    <>
      <path d="M8.5 17.5v-11" />
      <path d="M8.5 7h7l-1.5 2.5 1.5 2.5h-7" />
    </>
  ),
  live: (
    <>
      <circle cx="12" cy="12" r="1.6" />
      <path d="M9.2 9.2a4 4 0 0 0 0 5.6M14.8 9.2a4 4 0 0 1 0 5.6M7.4 7.4a6.5 6.5 0 0 0 0 9.2M16.6 7.4a6.5 6.5 0 0 1 0 9.2" />
    </>
  ),
  xp: <path d="m12 6.5 1.6 3.6 3.9.4-2.9 2.6.8 3.9-3.4-2-3.4 2 .8-3.9-2.9-2.6 3.9-.4Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="5.5" />
      <path d="M12 9v3.2l2 1.3" />
    </>
  ),
  course: (
    <>
      <path d="m12 7 6 3-6 3-6-3Z" />
      <path d="m6 13 6 3 6-3" />
    </>
  ),
  focus: (
    <>
      <circle cx="12" cy="12" r="5.5" />
      <circle cx="12" cy="12" r="2.2" />
    </>
  ),
  streak: <path d="M12 6.5c.5 2.4 3.8 3.6 3.8 7a3.8 3.8 0 0 1-7.6 0c0-1.6.9-2.6 1.8-3.3.1 1.1.6 1.8 1.4 2.1-.4-2.4.2-4.3.6-5.8Z" />,
  // Release-day legacy badges: a laurel star (Founding *) and a flag (Batch Pioneer).
  founding: (
    <>
      <path d="m12 7.2 1.2 2.6 2.8.3-2.1 1.9.6 2.8L12 13.4l-2.5 1.4.6-2.8L8 10.1l2.8-.3Z" />
      <path d="M7.5 15.5c1.2 1.4 2.8 2.1 4.5 2.1s3.3-.7 4.5-2.1" />
    </>
  ),
  pioneer: (
    <>
      <path d="M9 17.5V6.5" />
      <path d="M9 7h6.5l-1.6 2.3 1.6 2.3H9" />
    </>
  ),
  podium: (
    <>
      <path d="M7 17.5v-4h3.3v4M10.3 17.5V10h3.4v7.5M13.7 17.5v-5.5H17v5.5" />
    </>
  ),
  lock: (
    <>
      <rect x="8.5" y="11" width="7" height="6" rx="1" />
      <path d="M10 11V9.5a2 2 0 0 1 4 0V11" />
    </>
  ),
};

/** One badge medal: hexagon frame, glyph, tier pips. Earned = solid white; locked = dashed grey + lock. */
export function BadgeMedal({ badgeKey, tier, earned = false, size = 64 }) {
  const { pips } = tierInfo(tier);
  const glyph = earned ? GLYPHS[badgeGlyph(badgeKey)] || GLYPHS.lecture : GLYPHS.lock;
  const pipStart = 12 - (pips - 1) * 1.5;
  return (
    <svg
      className={`eg-medal${earned ? " is-earned" : " is-locked"}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path className="eg-medal__frame" d="M12 1.8 20.8 6.9v10.2L12 22.2 3.2 17.1V6.9Z" />
      {pips >= 3 ? <path className="eg-medal__inner" d="M12 3.9 19 7.95v8.1L12 20.1 5 16.05v-8.1Z" /> : null}
      <g className="eg-medal__glyph">{glyph}</g>
      {Array.from({ length: pips }, (_, index) => (
        <circle key={index} className="eg-medal__pip" cx={pipStart + index * 3} cy="19.2" r="0.7" />
      ))}
    </svg>
  );
}

/** "295 XP" pill; `pending` shows the optimistic value (worker not yet confirmed). */
export function XpChip({ xp, pending = false }) {
  return (
    <span className={`eg-chip eg-chip--xp${pending ? " is-pending" : ""}`}>
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
        {GLYPHS.xp}
      </svg>
      <span className="eg-chip__value">{formatXp(xp)}</span>
      <span className="eg-chip__unit">XP</span>
      {pending ? <span className="cds--visually-hidden"> (updating)</span> : null}
    </span>
  );
}

/** "3-day streak" pill with the flame glyph; dashed when the streak is not alive. */
export function StreakChip({ streak }) {
  const count = Math.max(0, Number(streak?.current) || 0);
  const alive = Boolean(streak?.alive) && count > 0;
  return (
    <span className={`eg-chip eg-chip--streak${alive ? "" : " is-idle"}`}>
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
        {GLYPHS.streak}
      </svg>
      <span className="eg-chip__value">{count}</span>
      <span className="eg-chip__unit">{count === 1 ? "day" : "days"}</span>
      <span className="cds--visually-hidden"> study streak</span>
    </span>
  );
}

/** Hairline stat strip (HackPath `border-y` band): `items = [{ label, value, hint }]`. */
export function StatStrip({ items = [], label = "Your progress", className = "" }) {
  const id = useId();
  if (!items.length) return null;
  return (
    <section className={`eg-stats ${className}`} aria-labelledby={id}>
      <h2 id={id} className="cds--visually-hidden">
        {label}
      </h2>
      <dl className="eg-stats__list" style={{ "--eg-stats-count": items.length }}>
        {items.map((item) => (
          <div key={item.label} className="eg-stats__cell">
            <dt className="eg-stats__label">{item.label}</dt>
            <dd className="eg-stats__value">
              {item.value}
              {item.hint ? <span className="eg-stats__hint">{item.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Page header (T8 inner page): golden eyebrow, h1 (optional handwritten accent), sub. */
export function PageIntro({ eyebrow, title, accent, sub, children, id }) {
  return (
    <header className="eg-intro">
      {eyebrow ? <p className="eg-intro__eyebrow">{eyebrow}</p> : null}
      <h1 className="eg-intro__title" id={id}>
        {title}
        {accent ? (
          <>
            {" "}
            <span className="hp-hand">{accent}</span>
          </>
        ) : null}
      </h1>
      {sub ? <p className="eg-intro__sub">{sub}</p> : null}
      {children}
    </header>
  );
}

// Engagement building blocks: progress ring, badge medal (our own line art),
// XP / streak chips and the stat strip. OWNER: WS-LEARN (console-student).
// Palette law: white, greys and golden white only; tiers and states are told
// apart by word + pips + solid/dashed strokes, never by hue. Badge medals are
// the one exception (owner request, Nov 2026): forged insignia metals with a
// cyan/emerald energy core, from ../landing-rewards/insigniaPalette.js.
import { useId } from "react";
import { HUE, METALS } from "../landing-rewards/insigniaPalette";
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

/* ---------------------------------------------------------------- medals */

const fx = (value) => Math.round(value * 100) / 100;
const at = (radius, degrees, cx = 32, cy = 32) => {
  const angle = (degrees * Math.PI) / 180;
  return [fx(cx + radius * Math.cos(angle)), fx(cy + radius * Math.sin(angle))];
};

/** Star-shaped outline: `points` tips at `outer`, valleys at `inner`. */
function burst(points, outer, inner, rotate = -90) {
  return Array.from({ length: points * 2 }, (_, index) => at(index % 2 ? inner : outer, rotate + (180 / points) * index).join(",")).join(" ");
}

/** Cross pattée: four arms flaring out to `reach`. */
const CROSS = [0, 90, 180, 270]
  .map((deg) => {
    const [a1, a2] = [at(12, deg - 90 - 24), at(12, deg - 90 + 24)];
    const [b1, b2] = [at(31, deg - 90 - 25), at(31, deg - 90 + 25)];
    const [c1, c2] = [at(22, deg - 90 - 12), at(22, deg - 90 + 12)];
    return `M${a1} Q${c1} ${b1} L${at(27, deg - 90)} L${b2} Q${c2} ${a2} Z`;
  })
  .join(" ");

/**
 * Military medal per tier (form + metal, never gold):
 *   bronze   gunmetal roundel with a knurled rim
 *   silver   steel disc on a cross pattée
 *   gold     platinum disc on an eight-point order star, cyan energy ring
 *   platinum obsidian disc on a platinum starburst, laurel, emerald/cyan core
 */
const MEDAL_TIERS = {
  bronze: { rim: "dark", field: "gun", glyph: "#d4d4d4", back: null },
  silver: { rim: "steel", field: "steelField", glyph: "#ffffff", back: "cross" },
  gold: { rim: "plat", field: "obs", glyph: HUE.platinum, back: "star", ring: HUE.cyan, glow: "cyan" },
  platinum: { rim: "plat", field: "obs", glyph: "#ffffff", back: "burst", ring: HUE.emerald, glow: "dual", laurel: true },
};

function MedalDefs({ id }) {
  const metal = (key, stops) => (
    <linearGradient key={key} id={`${id}-${key}`} x1="0" y1="0" x2="1" y2="1">
      {stops.map(([offset, colour]) => (
        <stop key={offset} offset={offset} stopColor={colour} />
      ))}
    </linearGradient>
  );
  const glow = (key, stops) => (
    <radialGradient key={key} id={`${id}-${key}`} cx="0.5" cy="0.5" r="0.5">
      {stops.map(([offset, colour, opacity]) => (
        <stop key={offset} offset={offset} stopColor={colour} stopOpacity={opacity} />
      ))}
    </radialGradient>
  );
  return (
    <defs>
      {metal("gun", METALS.gunmetal)}
      {metal("dark", METALS.dark)}
      {metal("steel", METALS.steel)}
      {metal("plat", METALS.platinum)}
      {metal("silver", METALS.silver)}
      {metal("obs", METALS.obsidian)}
      {metal("steelField", [
        [0, HUE.gunmetal],
        [0.6, "#1c1c1c"],
        [1, "#0a0a0a"],
      ])}
      {glow("cyan", [
        [0, HUE.cyan, 0.55],
        [0.55, HUE.cyanDeep, 0.25],
        [1, HUE.obsidian, 0],
      ])}
      {glow("dual", [
        [0, HUE.emerald, 0.6],
        [0.5, HUE.cyan, 0.3],
        [1, HUE.obsidian, 0],
      ])}
    </defs>
  );
}

function MedalLaurel({ fill }) {
  const leaves = [];
  for (const mirror of [false, true]) {
    for (let index = 0; index < 6; index += 1) {
      const deg = 100 + index * 13;
      const angle = mirror ? 180 - deg : deg;
      const [x, y] = at(27.5, angle);
      const tilt = (mirror ? angle - 90 : angle + 90) + (index % 2 ? 28 : -28) * (mirror ? -1 : 1);
      leaves.push(<ellipse key={`${mirror}-${index}`} cx={x} cy={y} rx="3.6" ry="1.4" transform={`rotate(${fx(tilt)} ${x} ${y})`} />);
    }
  }
  return (
    <g fill={fill} stroke="#000000" strokeWidth="0.4">
      {leaves}
    </g>
  );
}

/**
 * One badge medal: tier form and metal, the badge glyph, tier pips (studs).
 * Earned = forged metal; locked = the dashed grey outline of its form + a lock.
 */
export function BadgeMedal({ badgeKey, tier, earned = false, size = 64 }) {
  const { pips } = tierInfo(tier);
  const uid = `egm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const url = (key) => `url(#${uid}-${key})`;
  const tierKey = String(tier || "").toLowerCase();
  const spec = MEDAL_TIERS[tierKey] || MEDAL_TIERS.bronze;
  const fine = size > 40;
  const glyph = earned ? GLYPHS[badgeGlyph(badgeKey)] || GLYPHS.lecture : GLYPHS.lock;
  const disc = spec.back === "cross" ? 17.5 : spec.back ? 19 : 25;
  const field = disc - (spec.back ? 4.2 : 5);
  const pipY = 32 + field - 3.4;
  const pipStart = 32 - (pips - 1) * 3.3;
  const ink = earned ? spec.glyph : "#8a8a8a";
  const outline = earned ? { stroke: "#000000", strokeWidth: 0.9 } : { stroke: "#8a8a8a", strokeWidth: 1, strokeDasharray: "2.4 1.8" };
  const back = (fill) => {
    if (spec.back === "cross") return <path className="eg-medal__frame" d={CROSS} fill={fill} {...outline} strokeLinejoin="round" />;
    if (spec.back === "star") return <polygon className="eg-medal__frame" points={burst(8, 30, 21, -90)} fill={fill} {...outline} strokeLinejoin="round" />;
    if (spec.back === "burst") return <polygon className="eg-medal__frame" points={burst(16, 31, 23.5, -90)} fill={fill} {...outline} strokeLinejoin="round" />;
    return null;
  };
  return (
    <svg
      className={`eg-medal eg-medal--${MEDAL_TIERS[tierKey] ? tierKey : "bronze"}${earned ? " is-earned" : " is-locked"}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      {earned ? <MedalDefs id={uid} /> : null}
      {earned ? (
        <>
          {spec.glow ? <circle cx="32" cy="32" r="31.5" fill={url(spec.glow)} /> : null}
          {back(url(spec.back === "cross" ? "silver" : "plat"))}
          {spec.back === "star" && fine ? <polygon points={burst(8, 25, 14, -67.5)} fill={url("steel")} stroke="#000000" strokeWidth="0.6" /> : null}
          {spec.laurel && fine ? <MedalLaurel fill={url("plat")} /> : null}
          <circle className="eg-medal__inner" cx="32" cy="32" r={disc} fill={url(spec.rim)} stroke="#000000" strokeWidth="1" />
          {!spec.back && fine ? <circle cx="32" cy="32" r={disc - 2.4} fill="none" stroke="#000000" strokeOpacity="0.55" strokeWidth="1.6" strokeDasharray="0.9 1.3" /> : null}
          <circle cx="32" cy="32" r={field} fill={url(spec.field)} stroke="#000000" strokeWidth="0.8" />
          {spec.glow ? <circle cx="32" cy="32" r={field - 1} fill={url(spec.glow)} /> : null}
          {spec.ring ? <circle cx="32" cy="32" r={field - 1.6} fill="none" stroke={spec.ring} strokeOpacity="0.85" strokeWidth="0.9" /> : null}
        </>
      ) : (
        <>
          {back("#0a0a0a")}
          <circle className="eg-medal__inner" cx="32" cy="32" r={disc} fill="#0a0a0a" {...outline} />
          <circle cx="32" cy="32" r={field} fill="none" stroke="#525252" strokeWidth="0.8" strokeDasharray="1.6 1.6" />
        </>
      )}
      <g
        className="eg-medal__glyph"
        transform={`translate(32 ${pips ? 30 : 32}) scale(${fx((field * 2 * 0.56) / 12)}) translate(-12 -12)`}
        fill="none"
        stroke={ink}
        strokeWidth={earned ? 1.35 : 1.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {glyph}
      </g>
      {Array.from({ length: pips }, (_, index) => {
        const x = pipStart + index * 6.6;
        return (
          <polygon
            key={index}
            className="eg-medal__pip"
            points={`${fx(x)},${fx(pipY - 2.4)} ${fx(x + 2.1)},${fx(pipY)} ${fx(x)},${fx(pipY + 2.4)} ${fx(x - 2.1)},${fx(pipY)}`}
            fill={earned ? (spec.ring || "#e6e6e6") : "none"}
            stroke={earned ? "#000000" : "#8a8a8a"}
            strokeWidth="0.5"
          />
        );
      })}
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

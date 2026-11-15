// LVL badge: the student's level as a forged hex plate, the partner of the
// rank emblem (RankEmblem.jsx) in the "medal pair". OWNER: WS-LEARN.
//
// The level IS the rank number (backend apps/engagement/rules.py LEVELS: eight
// ranks, no finer level), so LVL 4 sits beside the Rank IV emblem.
//
// Metal climbs with the level, as the emblems do (no gold anywhere):
//   1-2 gunmetal rim · 3-4 steel rim, cyan line · 5-6 silver rim, cyan / emerald
//   7 platinum rim, cyan · 8 platinum rim, emerald and cyan (dual core)
// Sizes: from 41 px a square hex with "LVL" over a big number (`size` is the
// side); up to 40 px a horizontal hex tag reading "LVL 4" on one line (`size`
// is its height, the width is about 2.4x) so it stays legible at 24 px.
// Motion: the same slow sheen as the top emblems (rankEmblem.css), transform
// and opacity only, off under reduced motion. Colours: ./insigniaPalette.js.
import { useId } from "react";

import "./rankEmblem.css";

import { CORES, HUE, METALS } from "./insigniaPalette";

const FONT = "'Geist', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif";
const fx = (value) => Math.round(value * 100) / 100;

/** Pointy-top hexagon points around (cx, cy). */
function hex(cx, cy, radius) {
  const out = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = ((60 * index - 90) * Math.PI) / 180;
    out.push(`${fx(cx + radius * Math.cos(angle))},${fx(cy + radius * Math.sin(angle))}`);
  }
  return out.join(" ");
}

/** Horizontal hex tag (compact): flat top and bottom, pointed ends. */
function tag(inset = 0) {
  const i = inset;
  return `${fx(8 + i * 0.6)},${fx(1 + i)} ${fx(60 - i * 0.6)},${fx(1 + i)} ${fx(67 - i)},14 ${fx(60 - i * 0.6)},${fx(27 - i)} ${fx(8 + i * 0.6)},${fx(27 - i)} ${fx(1 + i)},14`;
}

/** Metal, accent and core per level (1-8). */
export function levelTier(level) {
  const number = Math.max(1, Math.min(8, Number(level) || 1));
  if (number <= 2) return { rim: "dark", accent: HUE.steelLight, accentOpacity: 0.45, core: "cyan", number };
  if (number <= 4) return { rim: "steel", accent: HUE.cyan, accentOpacity: 0.55, core: "cyan", number };
  if (number === 5) return { rim: "silver", accent: HUE.cyan, accentOpacity: 0.7, core: "cyan", number };
  if (number === 6) return { rim: "silver", accent: HUE.emerald, accentOpacity: 0.7, core: "emerald", number };
  if (number === 7) return { rim: "platinum", accent: HUE.cyan, accentOpacity: 0.85, core: "cyan", number };
  return { rim: "platinum", accent: HUE.emerald, accentOpacity: 0.9, core: "dual", number };
}

/** "auto": compact up to 40 px, standard below 120 px, full from 120 px. */
export function levelBadgeDetail(detail, size) {
  if (detail === "full" || detail === "standard" || detail === "compact") return detail;
  const px = Number(size) || 96;
  if (px <= 40) return "compact";
  return px < 120 ? "standard" : "full";
}

function Gradient({ id, stops }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      {stops.map(([offset, colour]) => (
        <stop key={offset} offset={offset} stopColor={colour} />
      ))}
    </linearGradient>
  );
}

/**
 * `number`: level 1-8. `size`: px (side of the hex; height of the compact tag).
 * Optional: `title` (rank title, added to the accessible name), `detail`
 * "auto" | "full" | "standard" | "compact", `animated` (ambient sheen from
 * level 6, default above 40 px), `decorative` (aria-hidden), `className`.
 */
export default function LevelBadge({ number = 1, size = 96, title = "", detail = "auto", animated, decorative = false, className = "" }) {
  const tier = levelTier(number);
  const level = tier.number;
  const uid = `lv${level}x${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const id = (key) => `${uid}-${key}`;
  const url = (key) => `url(#${id(key)})`;
  const mode = levelBadgeDetail(detail, size);
  const compact = mode === "compact";
  const full = mode === "full";
  const sheen = (animated ?? !compact) && level >= 6 && !compact;
  // Below 72 px the words grow (and the divider goes) so "LVL" stays legible.
  const small = !compact && !full && (Number(size) || 96) < 72;
  const label = `Level ${level} of 8${title ? `, ${title}` : ""}`;
  const height = Number(size) || 96;
  const width = compact ? Math.round((height * 68) / 28) : height;

  const defs = (
    <defs>
      <Gradient id={id("rim")} stops={METALS[tier.rim]} />
      <Gradient id={id("obs")} stops={METALS.obsidian} />
      <radialGradient id={id("core")} cx="0.5" cy="0.5" r="0.5" fx="0.42" fy="0.38">
        {CORES[tier.core].map(([offset, colour, opacity]) => (
          <stop key={offset} offset={offset} stopColor={colour} stopOpacity={opacity} />
        ))}
      </radialGradient>
      <radialGradient id={id("glow")} cx="0.5" cy="0.32" r="0.62">
        <stop offset="0" stopColor={tier.accent} stopOpacity={level >= 4 ? 0.22 : 0.1} />
        <stop offset="1" stopColor={tier.accent} stopOpacity="0" />
      </radialGradient>
      <radialGradient id={id("rivet")} cx="0.5" cy="0.5" r="0.5" fx="0.35" fy="0.3">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.45" stopColor="#9a9a9a" />
        <stop offset="1" stopColor="#262626" />
      </radialGradient>
      <linearGradient id={id("shine")} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
        <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.4" />
        <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
      </linearGradient>
      <clipPath id={id("clip")}>{compact ? <polygon points={tag()} /> : <polygon points={hex(60, 60, 56)} />}</clipPath>
    </defs>
  );

  const a11y = decorative ? { "aria-hidden": "true" } : { role: "img", "aria-label": label };

  if (compact) {
    return (
      <svg
        className={`lv-badge lv-badge--l${level} lv-badge--compact ${className}`.trim()}
        width={width}
        height={height}
        viewBox="0 0 68 28"
        focusable="false"
        data-level={level}
        data-detail="compact"
        {...a11y}
      >
        {defs}
        <polygon points={tag()} fill={url("rim")} stroke="#000000" strokeWidth="1" strokeLinejoin="round" />
        <polygon points={tag(2.4)} fill={url("obs")} stroke="#000000" strokeWidth="0.8" strokeLinejoin="round" />
        <path d="M30.5 6.5 V21.5" stroke={tier.accent} strokeOpacity={tier.accentOpacity} strokeWidth="1.2" />
        <text x="18.5" y="18.2" textAnchor="middle" fontFamily={FONT} fontSize="10.5" fontWeight="800" letterSpacing="0.5" fill={HUE.steelLight}>
          LVL
        </text>
        <text
          x="46"
          y="21"
          textAnchor="middle"
          fontFamily={FONT}
          fontSize="18"
          fontWeight="800"
          fill={HUE.platinum}
          stroke="#000000"
          strokeWidth="1.2"
          paintOrder="stroke"
        >
          {level}
        </text>
      </svg>
    );
  }

  // Rivets at the six vertices (full detail only).
  const rivets = full
    ? hex(60, 60, 51.2)
        .split(" ")
        .map((point) => point.split(",").map(Number))
    : [];

  return (
    <svg
      className={`lv-badge lv-badge--l${level} lv-badge--${mode}${sheen ? " lr-emblem--live" : ""} ${className}`.trim()}
      width={width}
      height={height}
      viewBox="0 0 120 120"
      focusable="false"
      data-level={level}
      data-detail={mode}
      {...a11y}
    >
      {defs}
      {level >= 7 ? <polygon points={hex(60, 60, 58.5)} fill="none" stroke={tier.accent} strokeOpacity="0.5" strokeWidth="3" strokeLinejoin="round" /> : null}
      <polygon points={hex(60, 60, 56)} fill={url("rim")} stroke="#000000" strokeWidth="1.6" strokeLinejoin="round" />
      <polygon points={hex(60, 60, 47.5)} fill={url("obs")} stroke="#000000" strokeWidth="1.4" strokeLinejoin="round" />
      <polygon points={hex(60, 60, 46)} fill={url("glow")} />
      <polygon
        points={hex(60, 60, 42.5)}
        fill="none"
        stroke={tier.accent}
        strokeOpacity={tier.accentOpacity}
        strokeWidth={full ? 0.9 : 1.3}
        strokeLinejoin="round"
        {...(full ? { strokeDasharray: "3 2" } : {})}
      />
      {rivets.length ? (
        <g fill={url("rivet")} stroke="#000000" strokeWidth="0.5">
          {rivets.map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="2.1" />
          ))}
        </g>
      ) : null}
      <text
        x="60"
        y={small ? 47 : 44}
        textAnchor="middle"
        fontFamily={FONT}
        fontSize={small ? 21 : 15}
        fontWeight="800"
        letterSpacing={small ? 1.5 : 3.4}
        fill={HUE.steelLight}
      >
        LVL
      </text>
      {small ? null : (
        <>
          <path d="M45 50.5 H55 M65 50.5 H75" stroke={tier.accent} strokeOpacity={tier.accentOpacity} strokeWidth="1.6" strokeLinecap="round" />
          <path d="M60 47.6 L62.9 50.5 L60 53.4 L57.1 50.5 Z" fill={url("core")} stroke="#000000" strokeWidth="0.5" />
        </>
      )}
      <text
        x="60"
        y={small ? 92 : 90}
        textAnchor="middle"
        fontFamily={FONT}
        fontSize={small ? 44 : 40}
        fontWeight="800"
        fill={HUE.platinum}
        stroke="#000000"
        strokeWidth="2"
        paintOrder="stroke"
      >
        {level}
      </text>
      {sheen ? (
        <g clipPath={url("clip")} aria-hidden="true">
          <g transform="rotate(20 60 60)">
            <rect className="lr-emblem__sheen" x="-40" y="-30" width="34" height="190" fill={url("shine")} />
          </g>
        </g>
      ) : null}
    </svg>
  );
}

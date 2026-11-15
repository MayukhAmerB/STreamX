// Rank emblems: one crafted SVG shield per rank, Recruit (I) to Elite
// Operator (VIII). Black, greys and white only (no gold): prestige climbs by
// form instead of hue. Chevrons count up (I-III), a star joins (IV-VI), the
// frame gains an inner border (III+), a crest gem (IV-VII) and a double rim
// (V+); steel bodies (V-VI) carry wings (VI+); platinum bodies (VII-VIII) add
// a laurel and a halo; Elite Operator alone is crowned and radiant.
import { useId } from "react";

import { romanRank } from "./landingRewardsModel";

const SHIELD = "M60 10 L100 22 V62 C100 92 83 112 60 122 C37 112 20 92 20 62 V22 Z";
const SHIELD_INNER = "M60 17 L94 27.5 V62 C94 88 79.5 105.5 60 114.5 C40.5 105.5 26 88 26 62 V27.5 Z";
const SHIELD_RIM = "M60 5 L105 18.5 V62 C105 95 86 117 60 128 C34 117 15 95 15 62 V18.5 Z";

/** Body gradient stops, frame stroke and insignia ink, per rank. */
const TIERS = [
  { body: ["#1d1d1d", "#0a0a0a"], frame: "#5c5c5c", ink: "#d9d9d9" },
  { body: ["#232323", "#0c0c0c"], frame: "#787878", ink: "#e6e6e6" },
  { body: ["#2b2b2b", "#0e0e0e"], frame: "#999999", ink: "#f0f0f0", inner: "#4d4d4d" },
  { body: ["#353535", "#121212"], frame: "#b8b8b8", ink: "#f5f5f5", inner: "#5c5c5c" },
  { body: ["#5c5c5c", "#1c1c1c"], frame: "#d6d6d6", ink: "#ffffff", inner: "#8a8a8a" },
  { body: ["#6e6e6e", "#202020"], frame: "#e8e8e8", ink: "#ffffff", inner: "#9e9e9e" },
  { body: ["#f2f2f2", "#9e9e9e", "#dcdcdc"], frame: "#ffffff", ink: "#161616", inner: "#6e6e6e" },
  { body: ["#ffffff", "#b0b0b0", "#ececec"], frame: "#ffffff", ink: "#0d0d0d", inner: "#5c5c5c" },
];

function starPoints(cx, cy, outer, inner = outer * 0.42) {
  const points = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = (Math.PI / 5) * index - Math.PI / 2;
    points.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return points.join(" ");
}

const chevron = (y) => `M41 ${y} L60 ${y + 10} L79 ${y}`;

/** Laurel leaves along a quadratic curve (left branch; the right one is mirrored). */
const LAUREL = (() => {
  const p0 = [57, 127];
  const p1 = [8, 120];
  const p2 = [11, 62];
  const at = (t) => [
    (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0],
    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1],
  ];
  const tangent = (t) => [
    2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]),
    2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]),
  ];
  const path = `M${p0.join(" ")} Q${p1.join(" ")} ${p2.join(" ")}`;
  const leaves = [0.14, 0.28, 0.42, 0.56, 0.7, 0.84, 0.97].map((t, index) => {
    const [x, y] = at(t);
    const [dx, dy] = tangent(t);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const side = index % 2 === 0 ? -1 : 1;
    return { x: x + side * 3.2 * Math.sin((angle * Math.PI) / 180), y: y - side * 3.2 * Math.cos((angle * Math.PI) / 180), angle: angle + side * 28 };
  });
  return { path, leaves };
})();

const RAYS = Array.from({ length: 24 }, (_, index) => {
  const angle = (Math.PI * 2 * index) / 24;
  const long = index % 2 === 0;
  const from = 50;
  const to = long ? 66 : 59;
  return {
    x1: (60 + from * Math.cos(angle)).toFixed(2),
    y1: (64 + from * Math.sin(angle)).toFixed(2),
    x2: (60 + to * Math.cos(angle)).toFixed(2),
    y2: (64 + to * Math.sin(angle)).toFixed(2),
    long,
  };
});

function Wing({ fill }) {
  return (
    <g fill={fill} stroke="#ffffff" strokeOpacity="0.35" strokeWidth="0.6" strokeLinejoin="round">
      <path d="M22 30 C12 29 4 35 0 44 C8 41 15 41 22 43 Z" />
      <path d="M22 44 C12 45 5 52 2 61 C9 57 16 57 22 58 Z" />
      <path d="M22 58 C14 60 8 67 6 75 C12 71 17 70 22 71 Z" />
    </g>
  );
}

function Laurel({ ink }) {
  return (
    <g fill={ink} stroke="none">
      <path d={LAUREL.path} fill="none" stroke={ink} strokeWidth="1.4" strokeLinecap="round" />
      {LAUREL.leaves.map((leaf, index) => (
        <ellipse key={index} cx={leaf.x.toFixed(2)} cy={leaf.y.toFixed(2)} rx="5.2" ry="2.1" transform={`rotate(${leaf.angle.toFixed(1)} ${leaf.x.toFixed(2)} ${leaf.y.toFixed(2)})`} />
      ))}
    </g>
  );
}

function Insignia({ number, ink }) {
  const stroke = { fill: "none", stroke: ink, strokeWidth: 5, strokeLinecap: "square", strokeLinejoin: "miter" };
  if (number <= 3) {
    const rows = { 1: [50], 2: [44, 57], 3: [38, 50, 62] }[number];
    return <g {...stroke}>{rows.map((y) => <path key={y} d={chevron(y)} />)}</g>;
  }
  if (number <= 6) {
    const rows = number === 4 ? [56, 68] : [52, 63, 74];
    return (
      <g>
        <polygon points={starPoints(60, 38, number === 6 ? 11 : 9.5)} fill={ink} />
        <g {...stroke} strokeWidth={number === 4 ? 5 : 4.4}>{rows.map((y) => <path key={y} d={chevron(y)} />)}</g>
      </g>
    );
  }
  return (
    <g>
      <circle cx="60" cy="56" r="19" fill="none" stroke={ink} strokeWidth="2.4" />
      <circle cx="60" cy="56" r="15" fill="none" stroke={ink} strokeWidth="0.8" strokeOpacity="0.6" />
      <polygon points={starPoints(60, 56, 12.5)} fill={ink} />
      {number === 8 ? (
        <>
          <polygon points={starPoints(34.5, 56, 4.4)} fill={ink} />
          <polygon points={starPoints(85.5, 56, 4.4)} fill={ink} />
        </>
      ) : null}
    </g>
  );
}

/**
 * `number`: rank 1-8. `size`: rendered width in px (height follows the 120:140 box).
 * `shine`: plays the celebratory sweep (transform/opacity only; off under reduced motion).
 */
export default function RankEmblem({ number = 1, title = "", size = 96, shine = false, className = "" }) {
  const rank = Math.max(1, Math.min(8, Number(number) || 1));
  const tier = TIERS[rank - 1];
  // The rank is part of every id: emblems from separate React roots never share a gradient.
  const uid = `lr${rank}x${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const bodyId = `${uid}-body`;
  const metalId = `${uid}-metal`;
  const haloId = `${uid}-halo`;
  const clipId = `${uid}-clip`;
  const shineId = `${uid}-shine`;
  const platinum = rank >= 7;
  const label = title ? `Rank ${romanRank(rank)}: ${title}` : `Rank ${romanRank(rank)}`;

  return (
    <svg
      className={`lr-emblem lr-emblem--r${rank} ${className}`}
      width={size}
      height={Math.round((size * 140) / 120)}
      viewBox="0 -8 120 140"
      role="img"
      aria-label={label}
      focusable="false"
      data-rank={rank}
    >
      <defs>
        <linearGradient id={bodyId} x1="0" y1="0" x2="0.35" y2="1">
          {tier.body.map((stop, index) => (
            <stop key={stop + index} offset={tier.body.length === 2 ? index : index / 2} stopColor={stop} />
          ))}
        </linearGradient>
        <linearGradient id={metalId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f5f5f5" />
          <stop offset="0.5" stopColor="#9a9a9a" />
          <stop offset="1" stopColor="#e0e0e0" />
        </linearGradient>
        <radialGradient id={haloId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity={rank === 8 ? 0.22 : 0.14} />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={shineId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity={platinum ? 0.75 : 0.32} />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clipId}>
          <path d={SHIELD} />
        </clipPath>
      </defs>

      {platinum ? <circle cx="60" cy="64" r="66" fill={`url(#${haloId})`} /> : null}
      {rank === 8 ? (
        <g stroke="#ffffff" strokeLinecap="round">
          {RAYS.map(({ long, ...ray }, index) => (
            <line key={index} {...ray} strokeWidth={long ? 1.6 : 1} strokeOpacity={long ? 0.45 : 0.25} />
          ))}
        </g>
      ) : null}
      {rank >= 6 ? (
        <g>
          <Wing fill={platinum ? `url(#${metalId})` : "#3a3a3a"} />
          <g transform="translate(120 0) scale(-1 1)">
            <Wing fill={platinum ? `url(#${metalId})` : "#3a3a3a"} />
          </g>
        </g>
      ) : null}
      {rank >= 7 ? (
        <g>
          <Laurel ink="#d4d4d4" />
          <g transform="translate(120 0) scale(-1 1)">
            <Laurel ink="#d4d4d4" />
          </g>
        </g>
      ) : null}

      {rank >= 5 ? <path d={SHIELD_RIM} fill="none" stroke={tier.frame} strokeOpacity="0.55" strokeWidth="1.2" /> : null}
      <path d={SHIELD} fill={`url(#${bodyId})`} stroke={tier.frame} strokeWidth={rank >= 5 ? 2.6 : 2} strokeLinejoin="round" />
      {tier.inner ? <path d={SHIELD_INNER} fill="none" stroke={tier.inner} strokeWidth="1.2" /> : null}

      <Insignia number={rank} ink={tier.ink} />

      <text
        x="60"
        y="101"
        textAnchor="middle"
        fontSize="10.5"
        fontWeight="700"
        letterSpacing="1.5"
        fill={tier.ink}
        fillOpacity="0.78"
        fontFamily="inherit"
      >
        {romanRank(rank)}
      </text>

      {rank >= 4 && rank < 8 ? (
        <path d="M60 2 L65.5 9.5 L60 17 L54.5 9.5 Z" fill={platinum ? "#ffffff" : tier.frame} stroke="#0a0a0a" strokeWidth="1" />
      ) : null}
      {rank === 8 ? (
        <g>
          <path d="M44 15 L45.5 2 L52.5 8.5 L60 -4 L67.5 8.5 L74.5 2 L76 15 Z" fill={`url(#${metalId})`} stroke="#ffffff" strokeWidth="1" strokeLinejoin="round" />
          <circle cx="45.5" cy="2" r="1.8" fill="#ffffff" />
          <circle cx="60" cy="-4" r="2" fill="#ffffff" />
          <circle cx="74.5" cy="2" r="1.8" fill="#ffffff" />
        </g>
      ) : null}

      {shine ? (
        <g clipPath={`url(#${clipId})`} aria-hidden="true">
          <g transform="rotate(18 60 64)">
            <rect className="lr-emblem__shine" x="-30" y="-20" width="34" height="180" fill={`url(#${shineId})`} />
          </g>
        </g>
      ) : null}
    </svg>
  );
}

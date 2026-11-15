// Rank emblems: one crafted SVG insignia per rank, Recruit (I) to Elite
// Operator (VIII), in an elite-unit / intelligence-agency style. OWNER: WS-LEARN.
//
// Prestige climbs by metal and by form (no gold anywhere):
//   I    Recruit            gunmetal heater shield, one chevron
//   II   Operative          gunmetal shield, riveted rim, two chevrons
//   III  Operator           notched steel shield, three chevrons and a rocker
//   IV   Analyst            steel radar roundel, sweep and cyan core, one star
//   V    Specialist         silver kite shield, crossed keys, cyan gem, two stars
//   VI   Senior Analyst     silver compass rose and globe, laurel, three stars
//   VII  Lead Investigator  platinum shield, crossed magnifiers, wings, laurel, aura
//   VIII Elite Operator     obsidian and platinum: crown, great wings, starburst,
//                           energy crystal, laurel, aura
// Every emblem carries its Roman numeral and (from 120 px) a ribbon with the
// rank title. Sizes up to 40 px draw a compact version (silhouette, chevrons
// or a big numeral, simplified wings and crown) so 24 px chips stay crisp.
// Motion (sheen, aura, starburst) is transform/opacity only and switched off
// under reduced motion (rankEmblem.css). Colours: ./insigniaPalette.js.
import { useId } from "react";

import "./rankEmblem.css";

import { LEVELS } from "../engagement-ui/engagementModel";
import { CORES, HUE, METALS } from "./insigniaPalette";
import { romanRank } from "./landingRewardsModel";

const FONT = "'Geist', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif";
const fx = (value) => Math.round(value * 100) / 100;

function starPoints(cx, cy, outer, inner = outer * 0.42, points = 5) {
  const out = [];
  for (let index = 0; index < points * 2; index += 1) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = (Math.PI / points) * index - Math.PI / 2;
    out.push(`${fx(cx + radius * Math.cos(angle))},${fx(cy + radius * Math.sin(angle))}`);
  }
  return out.join(" ");
}

const polar = (cx, cy, radius, degrees) => {
  const angle = (degrees * Math.PI) / 180;
  return [fx(cx + radius * Math.cos(angle)), fx(cy + radius * Math.sin(angle))];
};

/* ------------------------------------------------------------ silhouettes */

const HEATER = "M80 20 L124 32 V76 C124 108 106 128 80 140 C54 128 36 108 36 76 V32 Z";
const HEATER_IN = "M80 27 L117.5 37.5 V76 C117.5 104 101.5 121 80 131.5 C58.5 121 42.5 104 42.5 76 V37.5 Z";
const HEATER_LINE = "M80 31.5 L113 40.8 V76 C113 101.5 98.8 117 80 126.5 C61.2 117 47 101.5 47 76 V40.8 Z";

const NOTCHED = "M80 18 L96 27 L125 29 V76 C125 109 106 129 80 141 C54 129 35 109 35 76 V29 L64 27 Z";
const NOTCHED_IN = "M80 25.5 L94 33.5 L118.5 35 V76 C118.5 105 101.5 121.8 80 132.5 C58.5 121.8 41.5 105 41.5 76 V35 L66 33.5 Z";
const NOTCHED_LINE = "M80 30.5 L92.8 37.8 L114 39 V76 C114 102.4 98.6 117.5 80 127.4 C61.4 117.5 46 102.4 46 76 V39 L67.2 37.8 Z";

const KITE = "M80 16 L127 33 L121 92 L80 143 L39 92 L33 33 Z";
const KITE_IN = "M80 23.5 L120 38 L114.8 89.4 L80 132.6 L45.2 89.4 L40 38 Z";
const KITE_LINE = "M80 28.5 L115.4 41.2 L110.6 87.6 L80 126 L49.4 87.6 L44.6 41.2 Z";

const OGEE = "M80 18 Q101 29 127 24 V74 C127 109 106 131 80 143 C54 131 33 109 33 74 V24 Q59 29 80 18 Z";
const OGEE_IN = "M80 26 Q100 35.5 120 32 V74 C120 105 101.5 123.5 80 134 C58.5 123.5 40 105 40 74 V32 Q60 35.5 80 26 Z";
const OGEE_LINE = "M80 31 Q99 40 115.5 37.3 V74 C115.5 102 98.5 118.5 80 128.6 C61.5 118.5 44.5 102 44.5 74 V37.3 Q61 40 80 31 Z";

const TACTICAL = "M80 22 L119 29 L129 45 V80 C129 111 108 131 80 145 C52 131 31 111 31 80 V45 L41 29 Z";
const TACTICAL_IN = "M80 29.5 L114.6 35.6 L122 47.8 V80 C122 107 103.6 124.6 80 136.8 C56.4 124.6 38 107 38 80 V47.8 L45.4 35.6 Z";
const TACTICAL_LINE = "M80 34.5 L111.6 40 L117.5 49.8 V80 C117.5 104 101 119.8 80 130.8 C59 119.8 42.5 104 42.5 80 V49.8 L48.4 40 Z";

/* --------------------------------------------------------------- devices */

/** Upward chevron (enlisted stripe) whose apex sits at y. */
const chevron = (y, half = 28, rise = 13, thick = 8) =>
  `${80 - half},${y + rise} 80,${y} ${80 + half},${y + rise} ${80 + half},${y + rise + thick} 80,${y + thick} ${80 - half},${y + rise + thick}`;

function Chevrons({ rows, fill, half, rise, thick }) {
  return (
    <g fill={fill} stroke="#000000" strokeWidth="1.1" strokeLinejoin="miter">
      {rows.map((y) => (
        <polygon key={y} points={chevron(y, half, rise, thick)} />
      ))}
    </g>
  );
}

function Rivets({ points, fill }) {
  return (
    <g fill={fill} stroke="#000000" strokeWidth="0.6">
      {points.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1.9" />
      ))}
    </g>
  );
}

function NumeralPlate({ y, text, fill, stroke, width, scale = 1 }) {
  const w = width || 12 + text.length * 7.5;
  return (
    <g transform={scale === 1 ? undefined : `translate(80 ${y}) scale(${scale}) translate(-80 ${-y})`}>
      <rect x={fx(80 - w / 2)} y={y - 8} width={fx(w)} height="16" rx="2" fill={fill} stroke={stroke} strokeWidth="1.3" />
      <text x="80" y={y + 4.1} textAnchor="middle" fontFamily={FONT} fontSize="11.5" fontWeight="800" letterSpacing="1.2" fill={HUE.platinum}>
        {text}
      </text>
    </g>
  );
}

function Star({ cx, cy, r, fill }) {
  return <polygon points={starPoints(cx, cy, r)} fill={fill} stroke="#000000" strokeWidth="0.7" strokeLinejoin="round" />;
}

/** Ribbon scroll across the foot, carrying the rank title (full detail only). */
function Ribbon({ ctx, y = 124, edge, accent }) {
  const label = ctx.title.toUpperCase();
  const long = label.length > 11;
  return (
    <g>
      <g fill="#141414" stroke={edge} strokeWidth="1">
        <polygon points={`32,${y + 6} 7,${y + 6} 14,${y + 14} 7,${y + 22} 32,${y + 22}`} />
        <polygon points={`128,${y + 6} 153,${y + 6} 146,${y + 14} 153,${y + 22} 128,${y + 22}`} />
      </g>
      <g fill="#000000">
        <polygon points={`28,${y + 16} 32,${y + 22} 32,${y + 17.5}`} />
        <polygon points={`132,${y + 16} 128,${y + 22} 128,${y + 17.5}`} />
      </g>
      <path d={`M28 ${y} Q80 ${y + 10} 132 ${y} V${y + 16} Q80 ${y + 26} 28 ${y + 16} Z`} fill={ctx.url("ribbon")} stroke={edge} strokeWidth="1.2" />
      <path
        d={`M31 ${y + 2.6} Q80 ${y + 12.4} 129 ${y + 2.6} M31 ${y + 13.4} Q80 ${y + 23.2} 129 ${y + 13.4}`}
        fill="none"
        stroke={accent}
        strokeOpacity="0.7"
        strokeWidth="0.6"
      />
      <path id={ctx.id("arc")} d={`M30 ${y + 11.4} Q80 ${y + 21.4} 130 ${y + 11.4}`} fill="none" />
      <text fontFamily={FONT} fontSize={long ? 7.6 : 8.6} fontWeight="800" letterSpacing={long ? 0.6 : 1.6} fill={HUE.platinum}>
        <textPath href={`#${ctx.id("arc")}`} startOffset="50%" textAnchor="middle" {...(long ? { textLength: 90, lengthAdjust: "spacingAndGlyphs" } : {})}>
          {label}
        </textPath>
      </text>
    </g>
  );
}

/** A beveled plate: rim metal outside, field inside, an engraved line (full). */
function Plate({ ctx, outer, inner, line, rim, field, rimStroke = "#000000" }) {
  return (
    <g>
      <path d={outer} fill={rim} stroke={rimStroke} strokeWidth="1.4" strokeLinejoin="round" />
      <path d={inner} fill={field} stroke="#000000" strokeOpacity="0.85" strokeWidth="1.2" strokeLinejoin="round" />
      {ctx.engrave ? <path d={line} fill="none" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="0.7" strokeDasharray="2.2 1.6" /> : null}
    </g>
  );
}

/** Laurel sprigs (left drawn, right mirrored): leaves along an arc around (cx, cy). */
function Laurel({ cx = 80, cy = 78, radius = 58, from = 100, to = 168, count = 9, fill, stem }) {
  const leaves = [];
  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1);
    const deg = from + (to - from) * t;
    const [x, y] = polar(cx, cy, radius, deg);
    const growth = deg + 90;
    const side = index % 2 === 0 ? -1 : 1;
    const leafAngle = growth + side * 38;
    const length = 5.6 - t * 1.2;
    const [lx, ly] = polar(x, y, length * 0.9, leafAngle);
    leaves.push(<ellipse key={index} cx={lx} cy={ly} rx={fx(length)} ry="2" transform={`rotate(${fx(leafAngle)} ${lx} ${ly})`} />);
  }
  const [sx, sy] = polar(cx, cy, radius, from);
  const [ex, ey] = polar(cx, cy, radius, to);
  const [tx, ty] = polar(ex, ey, 4.4, to + 90);
  const branch = (
    <g>
      <path d={`M${sx} ${sy} A${radius} ${radius} 0 0 1 ${ex} ${ey}`} fill="none" stroke={stem} strokeWidth="1.4" strokeLinecap="round" />
      <g fill={fill} stroke="#000000" strokeWidth="0.5">
        {leaves}
        <ellipse cx={tx} cy={ty} rx="4.6" ry="1.9" transform={`rotate(${fx(to + 90)} ${tx} ${ty})`} />
      </g>
    </g>
  );
  return (
    <g>
      {branch}
      <g transform={`translate(${cx * 2} 0) scale(-1 1)`}>{branch}</g>
    </g>
  );
}

/**
 * Aviator wing (left; the right is mirrored): layered primaries sweeping up
 * and out from the shield shoulder, under a scalloped covert.
 */
function Wing({ feathers = 5, reach = 1, primary, alternate, covert, fine = true }) {
  const items = [];
  for (let index = feathers - 1; index >= 0; index -= 1) {
    const t = feathers === 1 ? 0 : index / (feathers - 1);
    const rootY = 46 + t * 34;
    const length = (40 - t * 17) * reach;
    const tipX = 46 - length;
    const tipY = rootY - (17 - t * 11) * reach;
    const half = 3.8 - t * 0.6;
    items.push(
      <g key={index}>
        <path
          d={`M46 ${fx(rootY - half)} C${fx(46 - length * 0.4)} ${fx(rootY - half - 2.5)} ${fx(tipX + length * 0.22)} ${fx(tipY - 1.5)} ${fx(tipX)} ${fx(tipY)} C${fx(tipX + length * 0.32)} ${fx(tipY + half * 2.4)} ${fx(46 - length * 0.45)} ${fx(rootY + half + 2)} 46 ${fx(rootY + half)} Z`}
          fill={index % 2 === 0 ? primary : alternate || primary}
        />
        {fine ? (
          <path
            d={`M44 ${fx(rootY)} Q${fx(46 - length * 0.5)} ${fx(rootY - 1.5)} ${fx(tipX + 4)} ${fx(tipY + 1.2)}`}
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.35"
            strokeWidth="0.5"
          />
        ) : null}
      </g>,
    );
  }
  return (
    <g stroke="#000000" strokeWidth="0.8" strokeLinejoin="round">
      {items}
      <path d="M52 40 C42 40 35 45 32 53 C36 55 35 61 31.5 65 C36 67 35 73 32.5 79 C38 84 45 87 52 87 Z" fill={covert} />
      {fine ? <path d="M48 46 C42 48 38 52 36.5 57 M48 60 C42 62 38 65 36 69 M49 73 C44 75 40 77 37.5 80" fill="none" stroke="#000000" strokeOpacity="0.45" strokeWidth="0.7" /> : null}
    </g>
  );
}

function Wings(props) {
  return (
    <g>
      <Wing {...props} />
      <g transform="translate(160 0) scale(-1 1)">
        <Wing {...props} />
      </g>
    </g>
  );
}

/** A key drawn pointing right from its bow at (0, 0). */
function Key({ fill }) {
  return (
    <g fill={fill} stroke="#000000" strokeWidth="0.8" strokeLinejoin="round">
      <path fillRule="evenodd" d="M-8 0 A8 8 0 1 0 8 0 A8 8 0 1 0 -8 0 Z M-3.4 0 A3.4 3.4 0 1 0 3.4 0 A3.4 3.4 0 1 0 -3.4 0 Z" />
      <rect x="7" y="-2.2" width="46" height="4.4" rx="1" />
      <rect x="10" y="-4" width="3" height="8" rx="0.8" />
      <path d="M41 2 H53 V10 H49 V6.5 H46 V10 H41 Z" />
    </g>
  );
}

/** A magnifier drawn pointing right from its lens at (0, 0). */
function Magnifier({ ctx, metal }) {
  return (
    <g stroke="#000000" strokeWidth="0.8" strokeLinejoin="round">
      <rect x="11" y="-2.6" width="9" height="5.2" fill={metal} />
      <rect x="19" y="-4.8" width="34" height="9.6" rx="4" fill={metal} />
      <path d="M26 -4.4 V4.4 M32 -4.4 V4.4 M38 -4.4 V4.4 M44 -4.4 V4.4" stroke="#000000" strokeOpacity="0.55" strokeWidth="1.2" />
      <circle r="13" fill={metal} />
      <circle r="9.4" fill={ctx.url("core")} />
      <path d="M-4 -2.6 A4.6 4.6 0 0 1 0.6 -4.6" fill="none" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="1.1" strokeLinecap="round" />
    </g>
  );
}

function Crown({ ctx, metal, y = 6 }) {
  const base = y + 18;
  return (
    <g stroke="#000000" strokeWidth="0.9" strokeLinejoin="round">
      <path
        d={`M58 ${base} L55 ${y + 6} L66 ${y + 13} L72 ${y + 1} L80 ${y + 9} L88 ${y + 1} L94 ${y + 13} L105 ${y + 6} L102 ${base} Z`}
        fill={metal}
      />
      <rect x="57" y={base - 1} width="46" height="6" rx="1.2" fill={metal} />
      <g fill={ctx.url("rivet")}>
        <circle cx="55" cy={y + 6} r="2.4" />
        <circle cx="72" cy={y + 1} r="2.4" />
        <circle cx="88" cy={y + 1} r="2.4" />
        <circle cx="105" cy={y + 6} r="2.4" />
      </g>
      <path d={`M80 ${y + 9} L84 ${y + 15} L80 ${y + 21} L76 ${y + 15} Z`} fill={ctx.url("core")} />
    </g>
  );
}

/** Starburst behind the top rank: 24 alternating rays. */
function Rays({ cx = 80, cy = 82, inner = 54, long = 78, short = 66, stroke }) {
  const rays = [];
  for (let index = 0; index < 24; index += 1) {
    const angle = index * 15;
    const isLong = index % 2 === 0;
    const [x1, y1] = polar(cx, cy, inner, angle);
    const [x2, y2] = polar(cx, cy, isLong ? long : short, angle);
    rays.push(<line key={index} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={isLong ? 1.6 : 1} strokeOpacity={isLong ? 0.55 : 0.32} />);
  }
  return (
    <g stroke={stroke} strokeLinecap="round">
      {rays}
    </g>
  );
}

/* ----------------------------------------------------------------- ranks */

const RIVETS_HEATER = [
  [80, 23.6],
  [40, 35.5],
  [120, 35.5],
  [39.3, 76],
  [120.7, 76],
];

function Recruit(ctx) {
  return (
    <g>
      <Plate ctx={ctx} outer={HEATER} inner={HEATER_IN} line={HEATER_LINE} rim={ctx.url("dark")} field={ctx.url("gun")} />
      {ctx.ribbon ? <NumeralPlate y={48} text="I" fill={ctx.url("obs")} stroke={ctx.url("dark")} width={22} /> : null}
      <Chevrons rows={ctx.ribbon ? [70] : [60]} fill={ctx.url("steel")} half={30} rise={15} thick={10} />
      {ctx.ribbon ? <Ribbon ctx={ctx} edge="#6a6a6a" accent="#8a8a8a" /> : null}
    </g>
  );
}

function Operative(ctx) {
  return (
    <g>
      <Plate ctx={ctx} outer={HEATER} inner={HEATER_IN} line={HEATER_LINE} rim={ctx.url("steel")} field={ctx.url("gun")} />
      {ctx.rivets ? <Rivets points={RIVETS_HEATER} fill={ctx.url("rivet")} /> : null}
      {ctx.ribbon ? <NumeralPlate y={47} text="II" fill={ctx.url("obs")} stroke={ctx.url("steel")} width={24} /> : null}
      <Chevrons rows={ctx.ribbon ? [64, 80] : [54, 72]} fill={ctx.url("silver")} half={30} rise={15} thick={9.5} />
      {ctx.ribbon ? <Ribbon ctx={ctx} edge="#8a8a8a" accent={HUE.steel} /> : null}
    </g>
  );
}

function Operator(ctx) {
  return (
    <g>
      <Plate ctx={ctx} outer={NOTCHED} inner={NOTCHED_IN} line={NOTCHED_LINE} rim={ctx.url("silver")} field={ctx.url("steelField")} />
      {ctx.rivets
        ? <Rivets points={[[80, 22], [38.4, 32], [121.6, 32], [38.4, 76], [121.6, 76], [52, 108], [108, 108]]} fill={ctx.url("rivet")} />
        : null}
      {ctx.ribbon ? <NumeralPlate y={45} text="III" fill={ctx.url("obs")} stroke={ctx.url("silver")} width={28} /> : null}
      <Chevrons rows={ctx.ribbon ? [58, 71, 84] : [46, 61, 76]} fill={ctx.url("silver")} half={29} rise={14} thick={8} />
      <path
        d={ctx.ribbon ? "M51 101 Q80 113 109 101 V108 Q80 120 51 108 Z" : "M51 96 Q80 109 109 96 V104 Q80 117 51 104 Z"}
        fill={ctx.url("silver")}
        stroke="#000000"
        strokeWidth="1.1"
      />
      {ctx.ribbon ? <Ribbon ctx={ctx} edge="#a3a3a3" accent={HUE.steelLight} /> : null}
    </g>
  );
}

function Analyst(ctx) {
  const ticks = [];
  const tickCount = ctx.engrave ? 48 : 12;
  for (let index = 0; index < tickCount; index += 1) {
    const angle = (360 / tickCount) * index;
    const major = index % (tickCount / 12) === 0;
    const [x1, y1] = polar(80, 80, major ? 38.6 : 40.6, angle);
    const [x2, y2] = polar(80, 80, 44, angle);
    ticks.push(<line key={index} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={major ? 1.4 : 0.7} />);
  }
  const [s1x, s1y] = polar(80, 80, 33, -90);
  const [s2x, s2y] = polar(80, 80, 33, -36);
  return (
    <g>
      {/* Bezel lugs: the roundel reads as a fitted instrument. */}
      <g fill={ctx.url("steel")} stroke="#000000" strokeWidth="1">
        <rect x="24" y="74" width="14" height="12" rx="2" />
        <rect x="122" y="74" width="14" height="12" rx="2" />
      </g>
      <circle cx="80" cy="80" r="47" fill={ctx.url("steel")} stroke="#000000" strokeWidth="1.4" />
      <circle cx="80" cy="80" r="37.5" fill={ctx.url("radar")} stroke="#000000" strokeWidth="1.2" />
      <g stroke={HUE.platinum} strokeOpacity="0.75">{ticks}</g>
      <g fill="none" stroke={HUE.cyan} strokeOpacity="0.38" strokeWidth="0.8">
        <circle cx="80" cy="80" r="26" />
        <circle cx="80" cy="80" r="15" />
        <path d="M80 44 V116 M44 80 H116" />
      </g>
      <path d={`M80 80 L${s1x} ${s1y} A33 33 0 0 1 ${s2x} ${s2y} Z`} fill={HUE.cyan} fillOpacity="0.2" />
      <path d={`M80 80 L${s2x} ${s2y}`} stroke={HUE.cyan} strokeWidth="1.6" strokeLinecap="round" />
      <g fill={HUE.cyan}>
        <circle cx="96" cy="64" r="2" />
        <circle cx="62" cy="96" r="1.5" />
        {ctx.engrave ? <circle cx="104" cy="92" r="1.2" /> : null}
      </g>
      <circle cx="80" cy="80" r="5.5" fill={ctx.url("core")} stroke="#000000" strokeWidth="0.8" />
      <Star cx={80} cy={16} r={10} fill={ctx.url("silver")} />
      {ctx.plate ? <NumeralPlate y={34} text="IV" fill={ctx.url("obs")} stroke={ctx.url("steel")} width={28} scale={ctx.plateScale} /> : null}
      {ctx.ribbon ? <Ribbon ctx={ctx} edge={HUE.steel} accent={HUE.cyan} /> : null}
    </g>
  );
}

function Specialist(ctx) {
  return (
    <g>
      <Plate ctx={ctx} outer={KITE} inner={KITE_IN} line={KITE_LINE} rim={ctx.url("silver")} field={ctx.url("steelField")} />
      {ctx.rivets ? <Rivets points={[[80, 19.8], [36.5, 35], [123.5, 35], [41.5, 90], [118.5, 90]]} fill={ctx.url("rivet")} /> : null}
      <g transform="translate(57 57) rotate(45)">
        <Key fill={ctx.url("silver")} />
      </g>
      <g transform="translate(103 57) rotate(135) scale(1 -1)">
        <Key fill={ctx.url("silver")} />
      </g>
      <path d="M80 68 L90 80 L80 92 L70 80 Z" fill={ctx.url("core")} stroke={HUE.platinum} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M80 68 L80 92 M70 80 H90" stroke="#ffffff" strokeOpacity="0.45" strokeWidth="0.6" />
      {ctx.plate ? <NumeralPlate y={41} text="V" fill={ctx.url("obs")} stroke={ctx.url("silver")} width={22} scale={ctx.plateScale} /> : null}
      <Star cx={ctx.ribbon ? 58 : 53} cy={ctx.ribbon ? 41 : 44} r={6} fill={ctx.url("plat")} />
      <Star cx={ctx.ribbon ? 102 : 107} cy={ctx.ribbon ? 41 : 44} r={6} fill={ctx.url("plat")} />
      {ctx.ribbon ? <Ribbon ctx={ctx} edge={HUE.steelLight} accent={HUE.cyan} /> : null}
    </g>
  );
}

function SeniorAnalyst(ctx) {
  const cx = 80;
  const cy = 76;
  const points = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = index * 45 - 90;
    const cardinal = index % 2 === 0;
    const [tx, ty] = polar(cx, cy, cardinal ? 68 : 56, angle);
    const [lx, ly] = polar(cx, cy, cardinal ? 30 : 26, angle - (cardinal ? 17 : 13));
    const [rx, ry] = polar(cx, cy, cardinal ? 30 : 26, angle + (cardinal ? 17 : 13));
    points.push(
      <g key={index}>
        <polygon points={`${cx},${cy} ${lx},${ly} ${tx},${ty}`} fill={ctx.url("plat")} />
        <polygon points={`${cx},${cy} ${tx},${ty} ${rx},${ry}`} fill={ctx.url("gun")} />
      </g>,
    );
  }
  const stars = [-118, -90, -62].map((deg) => polar(cx, cy, 40.5, deg));
  return (
    <g>
      {ctx.laurel ? <Laurel cx={cx} cy={cy} radius={53} from={102} to={158} count={9} fill={ctx.url("silver")} stem={HUE.steelLight} /> : null}
      <g stroke="#000000" strokeWidth="0.8" strokeLinejoin="round">{points}</g>
      <circle cx={cx} cy={cy} r="45" fill={ctx.url("silver")} stroke="#000000" strokeWidth="1.4" />
      <circle cx={cx} cy={cy} r="35.5" fill={ctx.url("obs")} stroke="#000000" strokeWidth="1.2" />
      <circle cx={cx} cy={cy} r="31" fill={ctx.url("glowE")} />
      <g fill="none" stroke={HUE.steelLight} strokeOpacity="0.8" strokeWidth="0.9">
        <circle cx={cx} cy={cy} r="29" />
        <ellipse cx={cx} cy={cy} rx="11" ry="29" />
        <ellipse cx={cx} cy={cy} rx="21" ry="29" />
        <path d={`M${cx - 29} ${cy} H${cx + 29} M${cx - 26.4} ${cy - 12} H${cx + 26.4} M${cx - 26.4} ${cy + 12} H${cx + 26.4} M${cx - 18} ${cy - 22.7} H${cx + 18} M${cx - 18} ${cy + 22.7} H${cx + 18}`} />
        <path d={`M${cx} ${cy - 29} V${cy + 29}`} />
      </g>
      <circle cx={cx} cy={cy} r="4.5" fill={ctx.url("coreE")} stroke="#000000" strokeWidth="0.7" />
      {stars.map(([x, y]) => (
        <Star key={x} cx={x} cy={y} r={4.6} fill={ctx.url("plat")} />
      ))}
      {ctx.plate ? <NumeralPlate y={116} text="VI" fill={ctx.url("obs")} stroke={ctx.url("silver")} width={28} scale={ctx.plateScale} /> : null}
      {ctx.ribbon ? <Ribbon ctx={ctx} y={126} edge={HUE.steelLight} accent={HUE.emerald} /> : null}
    </g>
  );
}

/** Ranks VII-VIII: the shield is drawn a little smaller so the wings fit the box. */
const SHRINK = "translate(80 88) scale(0.86) translate(-80 -88)";

function LeadInvestigator(ctx) {
  return (
    <g>
      {ctx.laurel ? <Laurel cx={80} cy={84} radius={58} from={98} to={150} count={9} fill={ctx.url("silver")} stem={HUE.steelLight} /> : null}
      <Wings feathers={5} reach={0.95} primary={ctx.url("steel")} alternate={ctx.url("silver")} covert={ctx.url("plat")} fine={ctx.engrave} />
      <g transform={SHRINK}>
      <Plate ctx={ctx} outer={OGEE} inner={OGEE_IN} line={OGEE_LINE} rim={ctx.url("plat")} field={ctx.url("obs")} />
      {ctx.rivets ? <Rivets points={[[80, 21.6], [36.5, 27.5], [123.5, 27.5], [36.5, 74], [123.5, 74]]} fill={ctx.url("rivet")} /> : null}
      <g transform="translate(58 55) rotate(45)">
        <Magnifier ctx={ctx} metal={ctx.url("plat")} />
      </g>
      <g transform="translate(102 55) rotate(135) scale(1 -1)">
        <Magnifier ctx={ctx} metal={ctx.url("plat")} />
      </g>
      <path d="M80 69 L86 76 L80 83 L74 76 Z" fill={ctx.url("coreE")} stroke={HUE.platinum} strokeWidth="1" strokeLinejoin="round" />
      {ctx.plate ? <NumeralPlate y={110} text="VII" fill={ctx.url("obs")} stroke={ctx.url("plat")} width={32} scale={ctx.plateScale} /> : null}
      <Star cx={63} cy={12} r={6} fill={ctx.url("plat")} />
      <Star cx={80} cy={8.5} r={8} fill={ctx.url("plat")} />
      <Star cx={97} cy={12} r={6} fill={ctx.url("plat")} />
      </g>
      {ctx.ribbon ? <Ribbon ctx={ctx} y={127} edge={HUE.platinum} accent={HUE.cyan} /> : null}
    </g>
  );
}

function EliteOperator(ctx) {
  const facets = [];
  for (let index = 0; index < 6; index += 1) {
    const [x, y] = polar(80, 84, 14, index * 60 - 90);
    facets.push(`${x},${y}`);
  }
  const compass = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = index * 45 - 90;
    const [tx, ty] = polar(80, 84, index % 2 === 0 ? 31 : 22, angle);
    const [lx, ly] = polar(80, 84, 6, angle - 45);
    const [rx, ry] = polar(80, 84, 6, angle + 45);
    compass.push(<polygon key={index} points={`${lx},${ly} ${tx},${ty} ${rx},${ry}`} />);
  }
  return (
    <g>
      {ctx.rays ? (
        <g className="lr-emblem__rays">
          <Rays stroke={HUE.platinum} />
        </g>
      ) : null}
      {ctx.laurel ? <Laurel cx={80} cy={84} radius={60} from={96} to={146} count={8} fill={ctx.url("plat")} stem={HUE.platinum} /> : null}
      <Wings feathers={7} reach={1.08} primary={ctx.url("plat")} alternate={ctx.url("steel")} covert={ctx.url("plat")} fine={ctx.engrave} />
      <g transform={SHRINK}>
      <path d={TACTICAL} fill="none" stroke={HUE.cyan} strokeOpacity="0.55" strokeWidth="5" strokeLinejoin="round" />
      <Plate ctx={ctx} outer={TACTICAL} inner={TACTICAL_IN} line={TACTICAL_LINE} rim={ctx.url("plat")} field={ctx.url("obs")} />
      <path d={TACTICAL_LINE} fill="none" stroke={HUE.platinum} strokeOpacity="0.55" strokeWidth="1" />
      {ctx.rivets ? <Rivets points={[[44.6, 33], [115.4, 33], [34.6, 50], [125.4, 50], [34.6, 80], [125.4, 80]]} fill={ctx.url("rivet")} /> : null}
      <g fill={ctx.url("plat")} stroke="#000000" strokeWidth="0.6" strokeLinejoin="round">
        {compass}
      </g>
      <polygon points={facets.join(" ")} fill={ctx.url("coreD")} stroke={HUE.platinum} strokeWidth="1.4" strokeLinejoin="round" />
      <path d={`M80 70 V98 M${facets[1]} L${facets[4]} M${facets[2]} L${facets[5]}`} stroke="#ffffff" strokeOpacity="0.35" strokeWidth="0.6" />
      {ctx.plate ? <NumeralPlate y={50} text="VIII" fill={ctx.url("obs")} stroke={ctx.url("plat")} width={36} scale={ctx.plateScale} /> : null}
      <Crown ctx={ctx} metal={ctx.url("plat")} y={2} />
      <Star cx={44} cy={20} r={5} fill={ctx.url("plat")} />
      <Star cx={116} cy={20} r={5} fill={ctx.url("plat")} />
      </g>
      {ctx.ribbon ? <Ribbon ctx={ctx} y={128} edge={HUE.platinum} accent={HUE.emerald} /> : null}
    </g>
  );
}

/* ------------------------------------------------------- compact (<=40 px) */

function BigNumeral({ text, y, size = 34, width }) {
  return (
    <text
      x="80"
      y={y}
      textAnchor="middle"
      fontFamily={FONT}
      fontSize={size}
      fontWeight="800"
      fill={HUE.platinum}
      stroke="#000000"
      strokeWidth="1.6"
      paintOrder="stroke"
      {...(width ? { textLength: width, lengthAdjust: "spacingAndGlyphs" } : {})}
    >
      {text}
    </text>
  );
}

function Compact(ctx, rank) {
  const thick = { half: 32, rise: 17, thick: 13 };
  switch (rank) {
    case 1:
      return (
        <g>
          <path d={HEATER} fill={ctx.url("dark")} stroke="#000000" strokeWidth="1.5" />
          <path d={HEATER_IN} fill={ctx.url("gun")} stroke="#000000" strokeWidth="1.2" />
          <Chevrons rows={[64]} fill={ctx.url("silver")} {...thick} thick={15} />
        </g>
      );
    case 2:
      return (
        <g>
          <path d={HEATER} fill={ctx.url("steel")} stroke="#000000" strokeWidth="1.5" />
          <path d={HEATER_IN} fill={ctx.url("gun")} stroke="#000000" strokeWidth="1.2" />
          <Chevrons rows={[50, 76]} fill={ctx.url("silver")} {...thick} />
        </g>
      );
    case 3:
      return (
        <g>
          <path d={NOTCHED} fill={ctx.url("silver")} stroke="#000000" strokeWidth="1.5" />
          <path d={NOTCHED_IN} fill={ctx.url("steelField")} stroke="#000000" strokeWidth="1.2" />
          <Chevrons rows={[40, 62, 84]} fill={ctx.url("plat")} half={32} rise={16} thick={12} />
        </g>
      );
    case 4:
      return (
        <g>
          <circle cx="80" cy="80" r="56" fill={ctx.url("steel")} stroke="#000000" strokeWidth="1.5" />
          <circle cx="80" cy="80" r="45" fill={ctx.url("radar")} stroke="#000000" strokeWidth="1.2" />
          <path d="M80 80 L80 38 A42 42 0 0 1 116 59 Z" fill={HUE.cyan} fillOpacity="0.28" />
          <BigNumeral text="IV" y={95} size={44} />
        </g>
      );
    case 5:
      return (
        <g>
          <path d={KITE} fill={ctx.url("silver")} stroke="#000000" strokeWidth="1.5" />
          <path d={KITE_IN} fill={ctx.url("steelField")} stroke="#000000" strokeWidth="1.2" />
          <path d="M80 104 L90 114 L80 124 L70 114 Z" fill={ctx.url("core")} />
          <BigNumeral text="V" y={96} size={50} />
        </g>
      );
    case 6: {
      const points = [0, 90, 180, 270].map((deg) => {
        const [tx, ty] = polar(80, 80, 66, deg - 90);
        const [lx, ly] = polar(80, 80, 20, deg - 135);
        const [rx, ry] = polar(80, 80, 20, deg - 45);
        return <polygon key={deg} points={`${lx},${ly} ${tx},${ty} ${rx},${ry}`} />;
      });
      return (
        <g>
          <g fill={ctx.url("plat")} stroke="#000000" strokeWidth="1">{points}</g>
          <circle cx="80" cy="80" r="50" fill={ctx.url("silver")} stroke="#000000" strokeWidth="1.5" />
          <circle cx="80" cy="80" r="40" fill={ctx.url("obs")} stroke="#000000" strokeWidth="1.2" />
          <circle cx="80" cy="80" r="36" fill={ctx.url("glowE")} />
          <BigNumeral text="VI" y={94} size={40} />
        </g>
      );
    }
    case 7:
      return (
        <g>
          <Wings feathers={3} reach={0.8} primary={ctx.url("silver")} covert={ctx.url("plat")} fine={false} />
          <path d={OGEE} fill={ctx.url("plat")} stroke="#000000" strokeWidth="1.5" />
          <path d={OGEE_IN} fill={ctx.url("obs")} stroke="#000000" strokeWidth="1.2" />
          <BigNumeral text="VII" y={94} size={38} width={64} />
        </g>
      );
    default:
      return (
        <g>
          <Wings feathers={4} reach={0.9} primary={ctx.url("plat")} alternate={ctx.url("steel")} covert={ctx.url("plat")} fine={false} />
          <path d={TACTICAL} fill="none" stroke={HUE.cyan} strokeOpacity="0.7" strokeWidth="6" strokeLinejoin="round" />
          <path d={TACTICAL} fill={ctx.url("plat")} stroke="#000000" strokeWidth="1.5" />
          <path d={TACTICAL_IN} fill={ctx.url("obs")} stroke="#000000" strokeWidth="1.2" />
          <Crown ctx={ctx} metal={ctx.url("plat")} y={0} />
          <BigNumeral text="VIII" y={100} size={36} width={70} />
        </g>
      );
  }
}

/* ------------------------------------------------------------- component */

const RANKS = [
  { render: Recruit, clip: <path d={HEATER} />, box: "20 16 120 128" },
  { render: Operative, clip: <path d={HEATER} />, box: "20 16 120 128" },
  { render: Operator, clip: <path d={NOTCHED} />, box: "20 14 120 130" },
  { render: Analyst, clip: <circle cx="80" cy="80" r="47" />, box: "20 20 120 120" },
  { render: Specialist, clip: <path d={KITE} />, box: "18 14 124 130" },
  { render: SeniorAnalyst, clip: <circle cx="80" cy="76" r="45" />, box: "12 12 136 136", standardBox: "10 6 140 140" },
  { render: LeadInvestigator, clip: <path d={OGEE} transform={SHRINK} />, box: "10 6 140 140", standardBox: "2 2 156 152" },
  { render: EliteOperator, clip: <path d={TACTICAL} transform={SHRINK} />, box: "6 2 148 148", standardBox: "0 0 160 156" },
];

function MetalGradient({ id, stops }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      {stops.map(([offset, colour]) => (
        <stop key={offset} offset={offset} stopColor={colour} />
      ))}
    </linearGradient>
  );
}

function CoreGradient({ id, stops, cx = 0.42, cy = 0.38 }) {
  return (
    <radialGradient id={id} cx="0.5" cy="0.5" r="0.5" fx={cx} fy={cy}>
      {stops.map(([offset, colour, opacity]) => (
        <stop key={offset} offset={offset} stopColor={colour} stopOpacity={opacity} />
      ))}
    </radialGradient>
  );
}

function GlowGradient({ id, colour, opacity }) {
  return (
    <radialGradient id={id} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stopColor={colour} stopOpacity={opacity} />
      <stop offset="0.6" stopColor={colour} stopOpacity={opacity * 0.35} />
      <stop offset="1" stopColor={colour} stopOpacity="0" />
    </radialGradient>
  );
}

/** "auto" picks compact up to 40 px, standard below 120 px, full from 120 px. */
export function emblemDetail(detail, size) {
  if (detail === "full" || detail === "standard" || detail === "compact") return detail;
  const px = Number(size) || 96;
  if (px <= 40) return "compact";
  return px < 120 ? "standard" : "full";
}

/**
 * `number`: rank 1-8. `title`: rank title (aria-label, ribbon). `size`: width
 * and height in px. `shine`: the celebratory sweep (plays 3 times).
 * Optional: `detail` "auto" | "full" | "standard" | "compact"; `animated`
 * (ambient sheen/aura/starburst on ranks VI-VIII; default: above 40 px);
 * `decorative` (aria-hidden, for places that already print the rank).
 */
export default function RankEmblem({
  number = 1,
  title = "",
  size = 96,
  shine = false,
  className = "",
  detail = "auto",
  animated,
  decorative = false,
}) {
  const rank = Math.max(1, Math.min(8, Number(number) || 1));
  // The rank is part of every id: emblems from separate React roots never share a gradient.
  const uid = `lr${rank}x${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const mode = emblemDetail(detail, size);
  const compact = mode === "compact";
  const full = mode === "full";
  const motion = animated ?? !compact;
  const name = title || LEVELS[rank - 1]?.title || "";
  const label = name ? `Rank ${romanRank(rank)}: ${name}` : `Rank ${romanRank(rank)}`;
  const id = (key) => `${uid}-${key}`;
  const ctx = {
    id,
    url: (key) => `url(#${id(key)})`,
    title: name,
    ribbon: full,
    engrave: full,
    plate: !compact,
    plateScale: full ? 1 : 1.5,
    rivets: !compact,
    laurel: !compact,
    rays: !compact,
  };
  const spec = RANKS[rank - 1];
  const prestige = rank >= 6;
  const aura = rank >= 7 && !compact;

  return (
    <svg
      className={`lr-emblem lr-emblem--r${rank} lr-emblem--${mode}${motion && prestige ? " lr-emblem--live" : ""} ${className}`.trim()}
      width={size}
      height={size}
      viewBox={compact ? spec.box : mode === "standard" ? spec.standardBox || "12 6 136 140" : "0 0 160 160"}
      focusable="false"
      data-rank={rank}
      data-detail={mode}
      {...(decorative ? { "aria-hidden": "true" } : { role: "img", "aria-label": label })}
    >
      <defs>
        <MetalGradient id={id("gun")} stops={METALS.gunmetal} />
        <MetalGradient id={id("dark")} stops={METALS.dark} />
        <MetalGradient id={id("steel")} stops={METALS.steel} />
        <MetalGradient id={id("silver")} stops={METALS.silver} />
        <MetalGradient id={id("plat")} stops={METALS.platinum} />
        <MetalGradient id={id("obs")} stops={METALS.obsidian} />
        <linearGradient id={id("steelField")} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor={HUE.gunmetal} />
          <stop offset="0.55" stopColor="#1c1c1c" />
          <stop offset="1" stopColor="#0a0a0a" />
        </linearGradient>
        <linearGradient id={id("ribbon")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2e2e2e" />
          <stop offset="0.5" stopColor={HUE.obsidian} />
          <stop offset="1" stopColor="#1f1f1f" />
        </linearGradient>
        <radialGradient id={id("radar")} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={HUE.cyanDeep} stopOpacity="0.55" />
          <stop offset="0.7" stopColor={HUE.obsidian} />
          <stop offset="1" stopColor="#000000" />
        </radialGradient>
        <radialGradient id={id("rivet")} cx="0.5" cy="0.5" r="0.5" fx="0.35" fy="0.3">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#9a9a9a" />
          <stop offset="1" stopColor="#262626" />
        </radialGradient>
        <CoreGradient id={id("core")} stops={CORES.cyan} />
        <CoreGradient id={id("coreE")} stops={CORES.emerald} />
        <CoreGradient id={id("coreD")} stops={CORES.dual} />
        <GlowGradient id={id("glowE")} colour={HUE.emerald} opacity={0.42} />
        {aura ? <GlowGradient id={id("aura")} colour={rank === 8 ? HUE.emerald : HUE.cyan} opacity={rank === 8 ? 0.34 : 0.26} /> : null}
        {aura ? <GlowGradient id={id("aura2")} colour={HUE.cyan} opacity={0.3} /> : null}
        <linearGradient id={id("shine")} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity={rank >= 7 ? 0.6 : 0.36} />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={id("clip")}>{spec.clip}</clipPath>
      </defs>

      {aura ? (
        <g className="lr-emblem__aura" aria-hidden="true">
          <circle cx="80" cy="82" r="80" fill={ctx.url("aura")} />
          {rank === 8 ? <circle cx="80" cy="82" r="56" fill={ctx.url("aura2")} /> : null}
        </g>
      ) : null}

      {compact ? Compact(ctx, rank) : spec.render(ctx)}

      {shine || (motion && prestige && !compact) ? (
        <g clipPath={ctx.url("clip")} aria-hidden="true">
          <g transform="rotate(20 80 80)">
            <rect
              className={shine ? "lr-emblem__shine" : "lr-emblem__sheen"}
              x="-40"
              y="-30"
              width="40"
              height="220"
              fill={ctx.url("shine")}
            />
          </g>
        </g>
      ) : null}
    </svg>
  );
}

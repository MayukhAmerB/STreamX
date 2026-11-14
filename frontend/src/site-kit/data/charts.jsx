// Hand-built data viz (UI overhaul plan §2.5, Appendix A.5). OWNER: WS-A.
// Every chart is a <figure> with a <figcaption> and a real <table>, so it
// reads without colour or vision. One neutral series; the "you" / current
// series is champagne on dark (ink on light); a target is a dashed hairline.
// Bars grow once (scaleX, slow-01, 40 ms stagger, max 6) when 30% in view;
// later changes tween to their new length and never replay from zero.
import { CountUp } from "../motion/components";
import { useInViewOnce, useReducedMotion } from "../motion/hooks";
import "../motion/motion.css";
import "./charts.css";

function DataTable({ caption, head, rows }) {
  return (
    <table className="sc-visually-hidden">
      <caption>{caption}</caption>
      {head ? (
        <thead>
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map(([label, value], index) => (
          <tr key={`${label}-${index}`}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const asNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Horizontal bars, label left and value right (tabular).
 * data: [{ label, value, highlight? }]; `target` draws a dashed tick (for
 * example the class average); `max` defaults to the largest value or target.
 */
export function BarList({ data = [], target, caption, max, format }) {
  const rows = Array.isArray(data) ? data : [];
  const [ref, seen] = useInViewOnce({ threshold: 0.3 });
  const reduced = useReducedMotion();
  const top = asNumber(max) || Math.max(1, ...rows.map((row) => asNumber(row.value)), asNumber(target));
  const show = (value) => (typeof format === "function" ? format(value) : value);
  const grown = seen || reduced;
  return (
    <figure ref={ref} className="sc-bar-list">
      {caption ? <figcaption className="sc-chart__caption">{caption}</figcaption> : null}
      <ol className="sc-bar-list__rows" aria-hidden="true">
        {rows.map((row, index) => {
          const ratio = Math.max(0, Math.min(1, asNumber(row.value) / top));
          return (
            <li key={`${row.label}-${index}`} className={`sc-bar-list__row${row.highlight ? " sc-bar-list__row--you" : ""}`}>
              <span className="sc-bar-list__label">{row.label}</span>
              <span className="sc-bar-list__track">
                <span
                  className="sc-bar-list__bar"
                  style={{ transform: `scaleX(${grown ? ratio : 0})`, transitionDelay: grown && !reduced ? `${Math.min(index, 6) * 40}ms` : "0ms" }}
                />
                {target != null ? <span className="sc-bar-list__target" style={{ left: `${Math.min(100, (asNumber(target) / top) * 100)}%` }} /> : null}
              </span>
              <span className="sc-bar-list__value">{typeof row.value === "number" && !format ? <CountUp value={row.value} /> : show(row.value)}</span>
            </li>
          );
        })}
      </ol>
      {target != null ? (
        <p className="sc-chart__legend" aria-hidden="true">
          <span className="sc-chart__legend-tick" /> Target {show(target)}
        </p>
      ) : null}
      <DataTable
        caption={caption || "Values"}
        head={["Item", "Value"]}
        rows={[...rows.map((row) => [row.label, show(row.value)]), ...(target != null ? [["Target", show(target)]] : [])]}
      />
    </figure>
  );
}

/** Tiny trend line (120 × 32): neutral line, the last point a champagne dot. points: number[]. */
export function Sparkline({ points = [], caption, width = 120, height = 32 }) {
  const values = (Array.isArray(points) ? points : []).map(asNumber);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const pad = 3;
  const coords = values.map((value, index) => {
    const x = values.length > 1 ? pad + (index / (values.length - 1)) * (width - pad * 2) : width / 2;
    const y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  const last = coords[coords.length - 1];
  return (
    <figure className="sc-sparkline">
      <svg className="sc-sparkline__svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
        {coords.length > 1 ? <polyline className="sc-sparkline__line" points={coords.map((point) => point.join(",")).join(" ")} /> : null}
        {last ? <circle className="sc-sparkline__dot" cx={last[0]} cy={last[1]} r="2" /> : null}
      </svg>
      {caption ? <figcaption className="sc-chart__caption sc-sparkline__caption">{caption}</figcaption> : null}
      <DataTable caption={caption || "Trend"} head={["Point", "Value"]} rows={values.map((value, index) => [String(index + 1), value])} />
    </figure>
  );
}

function deltaParts(delta) {
  if (delta == null || delta === "") return null;
  if (typeof delta === "object") return delta;
  const number = typeof delta === "number" ? delta : Number(String(delta).replace(/[^\d.-]/g, ""));
  const text = typeof delta === "number" ? `${Math.abs(delta)}%` : String(delta).replace(/^[+-]/, "");
  if (!Number.isFinite(number) || number === 0) return { direction: "flat", text };
  return { direction: number > 0 ? "up" : "down", text };
}

/**
 * One number with a label and an optional delta (▲ 12% / ▼ 3%, arrow glyph
 * and words, never colour alone). Numbers count up once (M5).
 */
export function StatTile({ label, value, delta, sessionKey, format }) {
  const parts = deltaParts(delta);
  const words = { up: "up", down: "down", flat: "no change" };
  return (
    <div className="sc-stat-tile">
      <p className="sc-stat-tile__label">{label}</p>
      <p className="sc-stat-tile__value">{typeof value === "number" ? <CountUp value={value} format={format} sessionKey={sessionKey} /> : value}</p>
      {parts ? (
        <p className={`sc-stat-tile__delta sc-stat-tile__delta--${parts.direction}`}>
          <span aria-hidden="true">{parts.direction === "up" ? "▲" : parts.direction === "down" ? "▼" : "–"} </span>
          <span className="sc-visually-hidden">{words[parts.direction] || ""} </span>
          {parts.text}
        </p>
      ) : null}
    </div>
  );
}

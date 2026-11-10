import { ChartLine, DataTable } from "@carbon/icons-react";
import { ContentSwitcher, IconSwitch } from "@carbon/react";
import { useEffect, useRef, useState } from "react";

const HEIGHT = 220;
const PAD = { top: 20, right: 28, bottom: 34, left: 44 };
const TICKS = [0, 25, 50, 75, 100];

function useWidth(fallback = 600) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect?.width || 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Chart geometry for the trend (exported for tests). */
export function trendGeometry(points, width) {
  const innerWidth = Math.max(40, width - PAD.left - PAD.right);
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : 0;
  const x = (index) => PAD.left + (points.length > 1 ? index * step : innerWidth / 2);
  const y = (percent) => PAD.top + innerHeight - (Math.max(0, Math.min(100, percent)) / 100) * innerHeight;
  const coords = points.map((point, index) => ({ ...point, cx: x(index), cy: y(point.percent) }));
  const line = coords.map((point, index) => `${index ? "L" : "M"} ${point.cx.toFixed(1)} ${point.cy.toFixed(1)}`).join(" ");
  const area = coords.length > 1 ? `${line} L ${coords.at(-1).cx.toFixed(1)} ${y(0)} L ${coords[0].cx.toFixed(1)} ${y(0)} Z` : "";
  return { coords, line, area, y, innerWidth };
}

/**
 * Marks per week as a percentage: one series in the champagne accent, a
 * hover/focus tooltip per point, the latest value labelled, and a table view
 * with the same numbers (the chart is never the only way to read them).
 */
export default function MarksTrendChart({ points = [], title = "Marks per week" }) {
  const [view, setView] = useState("chart");
  const [active, setActive] = useState(null);
  const [ref, width] = useWidth();
  const { coords, line, area, y } = trendGeometry(points, width);
  const last = coords.at(-1);
  const labelEvery = Math.max(1, Math.ceil(coords.length / Math.max(2, Math.floor(width / 56))));
  const summary = points.length
    ? `${title}: ${points.length} graded report${points.length === 1 ? "" : "s"}, latest ${last.percent}% (${last.marks}/${last.max}).`
    : `${title}: no graded reports yet.`;

  return (
    <figure className="rpt-trend">
      <div className="rpt-trend__head">
        <figcaption className="rpt-trend__title">{title}</figcaption>
        <ContentSwitcher
          size="sm"
          selectedIndex={view === "chart" ? 0 : 1}
          onChange={({ name }) => setView(name)}
          className="rpt-trend__switch"
        >
          <IconSwitch name="chart" text="Chart view">
            <ChartLine />
          </IconSwitch>
          <IconSwitch name="table" text="Table view">
            <DataTable />
          </IconSwitch>
        </ContentSwitcher>
      </div>
      {view === "chart" ? (
        <div className="rpt-trend__plot" ref={ref}>
          {points.length ? (
            <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={summary}>
              {TICKS.map((tick) => (
                <g key={tick}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className="rpt-trend__grid" />
                  <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end" className="rpt-trend__axis">
                    {tick}%
                  </text>
                </g>
              ))}
              {area ? <path d={area} className="rpt-trend__area" /> : null}
              {coords.length > 1 ? <path d={line} className="rpt-trend__line" /> : null}
              {coords.map((point, index) => (
                <g key={point.id}>
                  {index % labelEvery === 0 || index === coords.length - 1 ? (
                    <text x={point.cx} y={HEIGHT - 10} textAnchor="middle" className="rpt-trend__axis">
                      {point.label}
                    </text>
                  ) : null}
                  <circle
                    cx={point.cx}
                    cy={point.cy}
                    r={active === index ? 6 : 4.5}
                    className="rpt-trend__dot"
                    tabIndex={0}
                    aria-label={`${point.label} ${point.title}: ${point.marks}/${point.max} (${point.percent}%)`}
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(index)}
                    onBlur={() => setActive(null)}
                  />
                  <circle cx={point.cx} cy={point.cy} r={14} className="rpt-trend__hit" onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} />
                </g>
              ))}
              {last && active === null ? (
                <text x={Math.min(last.cx, width - PAD.right)} y={Math.max(14, last.cy - 12)} textAnchor="end" className="rpt-trend__value">
                  {last.percent}%
                </text>
              ) : null}
            </svg>
          ) : (
            <p className="rpt-trend__empty">Your marks will appear here once reports are graded.</p>
          )}
          {active !== null && coords[active] ? (
            <div
              className="rpt-trend__tooltip"
              role="status"
              style={{
                insetInlineStart: `${Math.min(Math.max(coords[active].cx, 70), width - 70)}px`,
                insetBlockStart: `${Math.max(0, coords[active].cy - 64)}px`,
              }}
            >
              <strong>
                {coords[active].label} · {coords[active].percent}%
              </strong>
              <span>{coords[active].title}</span>
              <span>
                {coords[active].marks}/{coords[active].max} marks
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <caption className="rpt-visually-hidden">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col">Report</th>
                <th scope="col" className="rpt-table__num">
                  Marks
                </th>
                <th scope="col" className="rpt-table__num">
                  Percent
                </th>
              </tr>
            </thead>
            <tbody>
              {points.length ? (
                points.map((point) => (
                  <tr key={point.id}>
                    <td>{point.label}</td>
                    <td>{point.title}</td>
                    <td className="rpt-table__num">
                      {point.marks}/{point.max}
                    </td>
                    <td className="rpt-table__num">{point.percent}%</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4}>No graded reports yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

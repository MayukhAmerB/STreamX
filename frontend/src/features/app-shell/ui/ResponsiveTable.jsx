// ResponsiveTable (UI overhaul plan §2.5, §4.6, Appendix A.5). OWNER: WS-A.
// A condensed Carbon-style table on wide screens (sticky header, sticky first
// column, a right-edge fade while more columns are off screen, a whole-row
// click target, bulk selection) and cards under `cardBreakpoint` so a phone
// never scrolls the page sideways. Loading shows a same-footprint skeleton
// after 300 ms; errors keep a Retry; empty shows the caller's EmptyState.
// columns: [{ key, header, render?(row), align? }]; rows need a stable `id`.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDelayedFlag } from "../../../site-kit/utils";
import { useStagger } from "../../../site-kit/motion";
import { useMediaQuery } from "../useBreakpoint";
import ErrorState from "./ErrorState";
import "./overhaul.scss";

function cell(column, row) {
  return column.render ? column.render(row) : row[column.key];
}

const isInteractive = (target) => Boolean(target?.closest?.("a, button, input, select, textarea, label, [role='button']"));

function RowLink({ href, children }) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/admin\/)/i.test(href)) return <a href={href}>{children}</a>;
  return <Link to={href}>{children}</Link>;
}

function SkeletonRows({ columns, count = 5, narrow }) {
  if (narrow) {
    return (
      <ul className="sc-table-cards" aria-hidden="true">
        {Array.from({ length: Math.min(count, 3) }, (_unused, index) => (
          <li key={index} className="sc-table-cards__card">
            <span className="sc-skeleton-line sc-skeleton-line--title" />
            <span className="sc-skeleton-line" />
            <span className="sc-skeleton-line" />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="sc-table-scroll" aria-hidden="true">
      <table className="sc-table">
        <tbody>
          {Array.from({ length: count }, (_unused, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>
                  <span className="sc-skeleton-line" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ResponsiveTable({
  columns = [],
  rows = [],
  getRowHref,
  selectable = false,
  onSelectionChange,
  emptyState = null,
  loading = false,
  error = null,
  onRetry,
  lastUpdated,
  cardBreakpoint = 672,
  caption,
  selected: controlledSelected,
}) {
  const narrow = useMediaQuery(`(max-width: ${cardBreakpoint - 0.02}px)`);
  const [ownSelected, setOwnSelected] = useState(() => new Set());
  const selected = controlledSelected ? new Set(controlledSelected) : ownSelected;
  const showSkeleton = useDelayedFlag(loading && !rows.length, 300);
  const enter = useStagger(!loading && rows.length > 0);
  const navigate = useNavigate();
  const scroller = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  useEffect(() => {
    const node = scroller.current;
    if (!node || narrow) return undefined;
    const measure = () => {
      const max = (node.scrollWidth || 0) - (node.clientWidth || 0);
      setEdges({ start: (node.scrollLeft || 0) <= 1, end: max <= 1 || (node.scrollLeft || 0) >= max - 1 });
    };
    measure();
    const win = typeof window !== "undefined" ? window : null;
    node.addEventListener?.("scroll", measure, { passive: true });
    win?.addEventListener?.("resize", measure);
    return () => {
      node.removeEventListener?.("scroll", measure);
      win?.removeEventListener?.("resize", measure);
    };
  }, [narrow, rows.length, columns.length]);

  if (error && !rows.length) return <ErrorState error={error} onRetry={onRetry} lastUpdated={lastUpdated} />;
  if (loading && !rows.length) {
    return showSkeleton ? (
      <div role="status" aria-busy="true" aria-live="polite">
        <span className="sc-visually-hidden">Loading</span>
        <SkeletonRows columns={columns} narrow={narrow} />
      </div>
    ) : null;
  }
  if (!rows.length) return emptyState;

  const setSelection = (next) => {
    if (!controlledSelected) setOwnSelected(next);
    onSelectionChange?.([...next]);
  };
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  };
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const toggleAll = () => setSelection(allSelected ? new Set() : new Set(rows.map((row) => row.id)));

  const [first, ...rest] = columns;
  const errorBanner = error ? <ErrorState error={error} onRetry={onRetry} lastUpdated={lastUpdated} /> : null;

  if (narrow) {
    return (
      <>
        {errorBanner}
        <ul className="sc-table-cards" aria-label={caption}>
          {rows.map((row, index) => {
            const href = getRowHref?.(row);
            const title = first ? cell(first, row) : null;
            return (
              <li key={row.id} className={`sc-table-cards__card${selected.has(row.id) ? " is-selected" : ""}`} {...enter(index)}>
                <div className="sc-table-cards__head">
                  {selectable ? (
                    <input
                      type="checkbox"
                      className="sc-check"
                      aria-label={`Select ${typeof title === "string" ? title : "row"}`}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  ) : null}
                  <div className="sc-table-cards__title">{href ? <RowLink href={href}>{title}</RowLink> : title}</div>
                </div>
                {rest.length ? (
                  <dl className="sc-table-cards__facts">
                    {rest.map((column) => (
                      <div key={column.key}>
                        <dt>{column.header}</dt>
                        <dd>{cell(column, row)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <>
      {errorBanner}
      <div className="sc-table-frame" data-scroll-start={edges.start ? "true" : "false"} data-scroll-end={edges.end ? "true" : "false"}>
        <div className="sc-table-scroll" ref={scroller} tabIndex={edges.start && edges.end ? undefined : 0} role="region" aria-label={caption || "Table"}>
          <table className={`sc-table${selectable ? " sc-table--selectable" : ""}`}>
            {caption ? <caption className="sc-visually-hidden">{caption}</caption> : null}
            <thead>
              <tr>
                {selectable ? (
                  <th scope="col" className="sc-table__select">
                    <input type="checkbox" className="sc-check" aria-label="Select all rows" checked={allSelected} onChange={toggleAll} />
                  </th>
                ) : null}
                {columns.map((column) => (
                  <th key={column.key} scope="col" className={column.align === "end" ? "sc-table__num" : undefined}>
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const href = getRowHref?.(row);
                return (
                  <tr
                    key={row.id}
                    className={`${href ? "is-clickable" : ""}${selected.has(row.id) ? " is-selected" : ""}`.trim() || undefined}
                    aria-selected={selectable ? selected.has(row.id) : undefined}
                    onClick={
                      href
                        ? (event) => {
                            if (isInteractive(event.target)) return;
                            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/admin\/)/i.test(href)) window.location.assign(href);
                            else navigate(href);
                          }
                        : undefined
                    }
                    {...(index < 6 ? enter(index) : {})}
                  >
                    {selectable ? (
                      <td className="sc-table__select">
                        <input type="checkbox" className="sc-check" aria-label="Select row" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                      </td>
                    ) : null}
                    {columns.map((column, columnIndex) => {
                      const content = cell(column, row);
                      const Tag = columnIndex === 0 ? "th" : "td";
                      return (
                        <Tag key={column.key} scope={columnIndex === 0 ? "row" : undefined} className={column.align === "end" ? "sc-table__num" : undefined}>
                          {columnIndex === 0 && href ? <RowLink href={href}>{content}</RowLink> : content}
                        </Tag>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

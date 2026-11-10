import { CenterCircle, ZoomIn, ZoomOut } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useMemo, useRef, useState } from "react";
import { initialViewBox, parseCanvas, wrapText, zoomViewBox } from "./canvasModel";

const PAN_STEP = 0.15;

function CardText({ node }) {
  const lineHeight = 22;
  const maxLines = Math.max(1, Math.floor((node.height - 16) / lineHeight));
  const lines = wrapText(node.display, node.width / 8.2, maxLines);
  return (
    <text x={node.x + 12} y={node.y + 26} className="rpt-canvas__text">
      {lines.map((line, index) => (
        <tspan key={index} x={node.x + 12} dy={index === 0 ? 0 : lineHeight}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/**
 * Read-only Obsidian canvas: cards and connections on a pannable SVG.
 * Drag (mouse or touch) or arrow keys to pan, buttons or +/- to zoom. A
 * screen-reader list of the cards follows the drawing.
 */
export default function CanvasPreview({ source, title = "Canvas" }) {
  const canvas = useMemo(() => parseCanvas(source), [source]);
  const [view, setView] = useState(() => initialViewBox(canvas.bounds));
  const [lastBounds, setLastBounds] = useState(canvas.bounds);
  const svgRef = useRef(null);
  const drag = useRef(null);

  if (lastBounds !== canvas.bounds) {
    setLastBounds(canvas.bounds);
    setView(initialViewBox(canvas.bounds));
  }

  if (canvas.error) {
    return <p className="rpt-preview__message">{canvas.error}</p>;
  }
  if (!canvas.nodes.length) {
    return <p className="rpt-preview__message">This canvas is empty.</p>;
  }

  const pan = (dx, dy) => setView((current) => ({ ...current, x: current.x + dx * current.width, y: current.y + dy * current.height }));
  const zoom = (factor) => setView((current) => zoomViewBox(current, factor));

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, view };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    const rect = svgRef.current?.getBoundingClientRect?.() || { width: 1, height: 1 };
    const start = drag.current.view;
    const scale = Math.max(start.width / Math.max(1, rect.width), start.height / Math.max(1, rect.height));
    setView({
      ...start,
      x: start.x - (event.clientX - drag.current.x) * scale,
      y: start.y - (event.clientY - drag.current.y) * scale,
    });
  };
  const endDrag = () => {
    drag.current = null;
  };
  const onKeyDown = (event) => {
    const keys = {
      ArrowLeft: () => pan(-PAN_STEP, 0),
      ArrowRight: () => pan(PAN_STEP, 0),
      ArrowUp: () => pan(0, -PAN_STEP),
      ArrowDown: () => pan(0, PAN_STEP),
      "+": () => zoom(0.8),
      "=": () => zoom(0.8),
      "-": () => zoom(1.25),
      0: () => setView(initialViewBox(canvas.bounds)),
    };
    if (keys[event.key]) {
      event.preventDefault();
      keys[event.key]();
    }
  };

  const cards = canvas.nodes.filter((node) => node.type !== "group");
  const label = `${title}: ${cards.length} card${cards.length === 1 ? "" : "s"} and ${canvas.edges.length} connection${canvas.edges.length === 1 ? "" : "s"}. Drag or use the arrow keys to move around.`;

  return (
    <div className="rpt-canvas">
      <div className="rpt-canvas__toolbar">
        <Button kind="ghost" size="sm" hasIconOnly renderIcon={ZoomIn} iconDescription="Zoom in" tooltipPosition="bottom" onClick={() => zoom(0.8)} />
        <Button kind="ghost" size="sm" hasIconOnly renderIcon={ZoomOut} iconDescription="Zoom out" tooltipPosition="bottom" onClick={() => zoom(1.25)} />
        <Button kind="ghost" size="sm" hasIconOnly renderIcon={CenterCircle} iconDescription="Fit to screen" tooltipPosition="bottom" onClick={() => setView(initialViewBox(canvas.bounds))} />
        {canvas.truncated ? <span className="rpt-canvas__note">Large canvas: showing the first 2,000 items.</span> : null}
      </div>
      <svg
        ref={svgRef}
        className="rpt-canvas__svg"
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={label}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        onKeyDown={onKeyDown}
      >
        <defs>
          <marker id="rpt-canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="rpt-canvas__arrow" />
          </marker>
        </defs>
        {canvas.nodes
          .filter((node) => node.type === "group")
          .map((node) => (
            <g key={node.id}>
              <rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx="14"
                className="rpt-canvas__group"
                style={node.color ? { stroke: node.color } : undefined}
              />
              {node.label ? (
                <text x={node.x + 10} y={node.y - 10} className="rpt-canvas__group-label">
                  {node.label}
                </text>
              ) : null}
            </g>
          ))}
        {canvas.edges.map((edge) => (
          <g key={edge.id}>
            <path
              d={edge.path}
              className="rpt-canvas__edge"
              style={edge.color ? { stroke: edge.color } : undefined}
              markerEnd={edge.arrowEnd ? "url(#rpt-canvas-arrow)" : undefined}
              markerStart={edge.arrowStart ? "url(#rpt-canvas-arrow)" : undefined}
            />
            {edge.label ? (
              <text x={(edge.start.x + edge.end.x) / 2} y={(edge.start.y + edge.end.y) / 2 - 6} className="rpt-canvas__edge-label" textAnchor="middle">
                {edge.label}
              </text>
            ) : null}
          </g>
        ))}
        {cards.map((node) => (
          <g key={node.id}>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx="10"
              className={`rpt-canvas__card rpt-canvas__card--${node.type}`}
              style={node.color ? { stroke: node.color } : undefined}
            />
            <CardText node={node} />
          </g>
        ))}
      </svg>
      <ul className="rpt-visually-hidden">
        {cards.map((node) => (
          <li key={node.id}>{node.display || "Empty card"}</li>
        ))}
      </ul>
    </div>
  );
}

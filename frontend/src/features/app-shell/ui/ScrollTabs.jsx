// ScrollTabs (UI overhaul plan §2.5, M13, Appendix A.5). OWNER: WS-A.
// Horizontally scrollable tabs (player, coursework, grading): fade hints at
// an edge while more tabs are hidden there, the active tab scrolled into
// view, and ONE indicator bar that slides between tabs with a transform
// (moderate-02, standard-expressive; it jumps under reduced motion).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "./overhaul.scss";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function ScrollTabs({ tabs = [], activeKey, label = "Sections" }) {
  const list = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const [bar, setBar] = useState(null);

  useIsoLayoutEffect(() => {
    const node = list.current;
    if (!node?.querySelector) return;
    const active = node.querySelector("[aria-current='page'], [aria-selected='true']");
    if (!active) {
      setBar(null);
      return;
    }
    setBar({ x: active.offsetLeft || 0, width: active.offsetWidth || 0 });
    if (typeof active.scrollIntoView === "function" && (node.scrollWidth || 0) > (node.clientWidth || 0)) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeKey, tabs.length]);

  useEffect(() => {
    const node = list.current;
    if (!node?.addEventListener) return undefined;
    const measure = () => {
      const max = (node.scrollWidth || 0) - (node.clientWidth || 0);
      setEdges({ start: (node.scrollLeft || 0) <= 1, end: max <= 1 || (node.scrollLeft || 0) >= max - 1 });
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    const win = typeof window !== "undefined" ? window : null;
    win?.addEventListener?.("resize", measure);
    return () => {
      node.removeEventListener("scroll", measure);
      win?.removeEventListener?.("resize", measure);
    };
  }, [tabs.length]);

  return (
    <nav className="sc-scroll-tabs" aria-label={label} data-scroll-start={edges.start ? "true" : "false"} data-scroll-end={edges.end ? "true" : "false"}>
      <ul ref={list}>
        {tabs.map((tab) => {
          const current = tab.key === activeKey;
          const content = (
            <>
              {tab.label}
              {tab.badge != null ? <span className="sc-scroll-tabs__badge">{tab.badge}</span> : null}
            </>
          );
          return (
            <li key={tab.key}>
              {tab.href ? (
                <Link to={tab.href} aria-current={current ? "page" : undefined}>
                  {content}
                </Link>
              ) : (
                <button type="button" aria-current={current ? "page" : undefined} onClick={tab.onClick}>
                  {content}
                </button>
              )}
            </li>
          );
        })}
        {bar && bar.width ? (
          <li aria-hidden="true" className="sc-scroll-tabs__bar" style={{ transform: `translateX(${bar.x}px) scaleX(${bar.width})` }} />
        ) : null}
      </ul>
    </nav>
  );
}

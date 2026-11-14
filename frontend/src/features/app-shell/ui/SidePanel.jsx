// SidePanel (UI overhaul plan §2.5, §4.6, Appendix A.5). OWNER: WS-A.
// A 480 px panel on the right (full screen on phones) with tabs (Summary ·
// Activity · Advanced) and a sticky footer for Save/Cancel. It enters with
// translateX(100% → 0) over 240 ms and leaves over 150 ms (M11); Esc closes;
// focus moves to the title on open and back to the trigger on close.
// Deep link: `useSidePanelParam()` keeps `?open=<id>` in the URL, so a
// reviewed record can be shared or reloaded.
import { Close } from "@carbon/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { prefersReducedMotionNow } from "../../../site-kit/motion";
import "./overhaul.scss";

const EXIT_MS = 150;

/** `[openId, setOpenId]` backed by the `?open=` search param (or `param`). */
export function useSidePanelParam(param = "open") {
  const [params, setParams] = useSearchParams();
  const openId = params.get(param);
  const setOpenId = useCallback(
    (id) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id == null || id === "") next.delete(param);
          else next.set(param, String(id));
          return next;
        },
        { replace: false }
      );
    },
    [param, setParams]
  );
  return [openId, setOpenId];
}

export default function SidePanel({ open, title, onClose, tabs = null, footer = null, children, deepLinkParam = "open", subtitle }) {
  const titleId = useId();
  const tabsId = useId();
  const [active, setActive] = useState(tabs?.[0]?.key ?? null);
  const [rendered, setRendered] = useState(Boolean(open));
  const [leaving, setLeaving] = useState(false);
  const heading = useRef(null);
  const opener = useRef(null);

  // Mount on open; keep mounted for the exit animation on close.
  useEffect(() => {
    if (open) {
      opener.current = typeof document !== "undefined" ? document.activeElement : null;
      setRendered(true);
      setLeaving(false);
      return undefined;
    }
    if (!rendered) return undefined;
    setLeaving(true);
    const timer = setTimeout(
      () => {
        setRendered(false);
        setLeaving(false);
        opener.current?.focus?.();
        opener.current = null;
      },
      prefersReducedMotionNow() ? 0 : EXIT_MS
    );
    return () => clearTimeout(timer);
    // `rendered` is read, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && rendered) heading.current?.focus?.();
  }, [open, rendered]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!rendered) return null;
  const current = tabs?.find((tab) => tab.key === active) || tabs?.[0];
  return (
    <aside
      className={`sc-side-panel${leaving ? " is-leaving" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-deep-link-param={deepLinkParam}
    >
      <header className="sc-side-panel__header">
        <div className="sc-side-panel__heading">
          <h2 id={titleId} ref={heading} tabIndex={-1} className="sc-side-panel__title">
            {title}
          </h2>
          {subtitle ? <p className="sc-side-panel__subtitle">{subtitle}</p> : null}
        </div>
        <button type="button" className="sc-icon-button" aria-label="Close panel" onClick={onClose}>
          <Close size={20} aria-hidden="true" />
        </button>
      </header>
      {tabs?.length ? (
        <div className="sc-side-panel__tabs" role="tablist" aria-label={`${title} sections`}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              id={`${tabsId}-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={tab.key === current?.key}
              aria-controls={`${tabsId}-panel`}
              tabIndex={tab.key === current?.key ? 0 : -1}
              onClick={() => setActive(tab.key)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                const index = tabs.findIndex((item) => item.key === current?.key);
                const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                setActive(next.key);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="sc-side-panel__body"
        id={`${tabsId}-panel`}
        role={tabs?.length ? "tabpanel" : undefined}
        aria-labelledby={tabs?.length && current ? `${tabsId}-${current.key}` : undefined}
      >
        {current ? current.content : children}
      </div>
      {footer ? <footer className="sc-side-panel__footer">{footer}</footer> : null}
    </aside>
  );
}

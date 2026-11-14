// Toast v2 (UI overhaul plan §2.5, M10). OWNER: WS-A.
// Top right on desktop, above the bottom nav on phones (positioned by the
// shell's .cds-app-toasts). Enters with opacity + 8 px (moderate-01), leaves
// with a fade and 16 px slide (fast-02), siblings move with FLIP. A 2 px
// hairline shows the time left and PAUSES on hover or focus (WCAG 2.2.1).
// At most 3; announced politely. Optional action ("Undo") beside the text.
import { CheckmarkFilled, Close, ErrorFilled, InformationFilled, WarningFilled } from "@carbon/icons-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotionNow, useFlip } from "../../../site-kit/motion";
import "./overhaul.scss";

const ToastContext = createContext(null);
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TOASTS = 3;
const EXIT_MS = 110;

const ICONS = {
  success: CheckmarkFilled,
  error: ErrorFilled,
  warning: WarningFilled,
  "warning-alt": WarningFilled,
  info: InformationFilled,
  "info-square": InformationFilled,
};

/** One toast: a pausable timer drives both the hairline and the dismissal. */
export function Toast({ toast, onDismiss }) {
  const { kind = "success", title, subtitle, timeout = DEFAULT_TIMEOUT_MS, action, leaving } = toast;
  const [paused, setPaused] = useState(false);
  const remaining = useRef(timeout);
  const startedAt = useRef(0);
  const Icon = ICONS[kind] || InformationFilled;

  useEffect(() => {
    if (!timeout || paused || leaving) return undefined;
    startedAt.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), Math.max(0, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [timeout, paused, leaving, onDismiss, toast.id]);

  const pause = () => setPaused(true);
  const resume = (event) => {
    if (event?.currentTarget?.contains?.(event.relatedTarget)) return;
    setPaused(false);
  };

  return (
    <div
      className={`sc-toast sc-toast--${kind}${leaving ? " is-leaving" : ""}${paused ? " is-paused" : ""}`}
      data-flip-key={toast.id}
      role={kind === "error" ? "alert" : "status"}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
    >
      <Icon size={20} aria-hidden="true" className="sc-toast__icon" />
      <div className="sc-toast__text">
        <p className="sc-toast__title">{title}</p>
        {subtitle ? <p className="sc-toast__subtitle">{subtitle}</p> : null}
      </div>
      {action ? (
        <button
          type="button"
          className="sc-toast__action"
          onClick={() => {
            action.onClick?.();
            onDismiss(toast.id);
          }}
        >
          {action.label}
        </button>
      ) : null}
      <button type="button" className="sc-toast__close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <Close size={16} aria-hidden="true" />
      </button>
      {timeout ? <span className="sc-toast__timer" aria-hidden="true" style={{ animationDuration: `${timeout}ms` }} /> : null}
    </div>
  );
}

/** Holds transient toasts for the shell. Wrap the shell once. */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);
  const flip = useFlip();
  const { capture } = flip;

  const removeNow = useCallback(
    (id) => {
      capture();
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [capture]
  );

  const dismissToast = useCallback(
    (id) => {
      if (prefersReducedMotionNow()) {
        removeNow(id);
        return;
      }
      setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
      setTimeout(() => removeNow(id), EXIT_MS);
    },
    [removeNow]
  );

  const showToast = useCallback(
    ({ kind = "success", title, subtitle = "", timeout = DEFAULT_TIMEOUT_MS, action = null }) => {
      const id = nextId.current++;
      capture();
      setToasts((current) => [...current, { id, kind, title, subtitle, timeout, action }].slice(-MAX_TOASTS));
      return id;
    },
    [capture]
  );

  const value = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cds-app-toasts sc-toasts" ref={flip.ref} aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const noop = () => 0;

/** `const { showToast } = useToast(); showToast({ kind: "success", title: "Saved", action: { label: "Undo", onClick } })` */
export function useToast() {
  return useContext(ToastContext) || { showToast: noop, dismissToast: noop };
}

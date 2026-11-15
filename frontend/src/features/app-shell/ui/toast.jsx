import { ToastNotification } from "@carbon/react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const ToastContext = createContext(null);
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TOASTS = 3;

/** Holds transient toasts for the shell. Wrap the shell once. */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(({ kind = "success", title, subtitle = "", timeout = DEFAULT_TIMEOUT_MS }) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, kind, title, subtitle, timeout }].slice(-MAX_TOASTS));
    return id;
  }, []);

  const value = useMemo(() => ({ showToast, dismissToast }), [showToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cds-app-toasts">
        {toasts.map((toast) => (
          <ToastNotification
            key={toast.id}
            lowContrast
            kind={toast.kind}
            title={toast.title}
            subtitle={toast.subtitle}
            timeout={toast.timeout}
            onClose={() => {
              dismissToast(toast.id);
              return false;
            }}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const noop = () => 0;

/** `const { showToast } = useToast(); showToast({ kind: "success", title: "Saved" })` */
export function useToast() {
  return useContext(ToastContext) || { showToast: noop, dismissToast: noop };
}

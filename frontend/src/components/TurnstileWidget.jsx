import { useEffect, useRef, useState } from "react";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let turnstileScriptPromise;

function loadTurnstileScript() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Turnstile can only load in the browser."));
  }
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.turnstile), { once: true });
      existingScript.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error("Unable to load Turnstile."));
    };
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}

export default function TurnstileWidget({
  siteKey,
  action,
  onToken,
  onExpire,
  onError,
  resetSignal = 0,
  className = "",
}) {
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  const callbacksRef = useRef({ onToken, onExpire, onError });
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    callbacksRef.current = { onToken, onExpire, onError };
  }, [onToken, onExpire, onError]);

  useEffect(() => {
    if (!siteKey) {
      return undefined;
    }

    let cancelled = false;
    setLoadError("");

    loadTurnstileScript()
      .then((turnstile) => {
        const renderWidget = () => {
          if (cancelled || !containerRef.current || widgetIdRef.current !== null) {
            return;
          }
          widgetIdRef.current = turnstile.render(containerRef.current, {
            sitekey: siteKey,
            action,
            theme: "auto",
            callback: (token) => callbacksRef.current.onToken?.(token),
            "expired-callback": () => callbacksRef.current.onExpire?.(),
            "error-callback": (errorCode) => callbacksRef.current.onError?.(errorCode),
          });
        };

        renderWidget();
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLoadError("Security check could not load. Refresh the page and try again.");
        callbacksRef.current.onError?.("script-load-failed");
      });

    return () => {
      cancelled = true;
      if (window.turnstile && widgetIdRef.current !== null) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore cleanup failures from a third-party widget during route changes.
        }
      }
      widgetIdRef.current = null;
    };
  }, [siteKey, action]);

  useEffect(() => {
    if (!window.turnstile || widgetIdRef.current === null) {
      return;
    }
    try {
      window.turnstile.reset(widgetIdRef.current);
    } catch {
      // A failed reset will be surfaced by the next submit via the missing token guard.
    }
  }, [resetSignal]);

  if (!siteKey) {
    return null;
  }

  return (
    <div className={className}>
      <div ref={containerRef} className="min-h-[65px]" />
      {loadError ? (
        <div className="mt-2 rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {loadError}
        </div>
      ) : null}
    </div>
  );
}

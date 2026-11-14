import { forwardRef, useId, useState } from "react";

import { ChevronDown, ChevronRight, Eye, EyeOff, Info, OctagonX, TriangleAlert, CheckCircle } from "./icons";

/**
 * Underline field (PHILOSOPHY §2.7 sign-in, §3.2 `.underline-field`): an 11 px
 * visible label, a transparent input on a white/35 bottom rule that turns
 * golden white on focus, an optional hint and an error line tied to the input
 * with aria-describedby + aria-invalid.
 *
 * - as: "input" (default) | "textarea" | "select" (pass <option>s as children)
 * - reveal: adds a labelled show/hide toggle for a password input
 * - required: shows a muted "*" (aria-hidden; the input keeps `required`)
 */
export const AuthField = forwardRef(function AuthField(
  { label, hint, error, as = "input", reveal = false, className = "", id: givenId, children, type, ...props },
  ref
) {
  const autoId = useId();
  const id = givenId || autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const [shown, setShown] = useState(false);
  const describedBy = [props["aria-describedby"], hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const Element = as;
  const inputType = as === "input" ? (reveal ? (shown ? "text" : "password") : type) : undefined;

  return (
    <div className={`au-field ${className}`.trim()}>
      {/* The "*" stays outside the <label> so the field's name is exactly its label ("Password"). */}
      <div className="au-label-row">
        <label className="au-label" htmlFor={id}>
          {label}
        </label>
        {props.required ? (
          <span className="au-label__req" aria-hidden="true">
            *
          </span>
        ) : null}
      </div>
      <div className="au-control" data-invalid={error ? "true" : undefined}>
        <Element
          ref={ref}
          id={id}
          className="au-input"
          type={inputType}
          {...props}
          aria-invalid={error ? "true" : props["aria-invalid"]}
          aria-describedby={describedBy}
        >
          {children}
        </Element>
        {as === "select" ? <ChevronDown className="au-select-chevron" /> : null}
        {reveal ? (
          <button
            type="button"
            className="au-reveal"
            aria-label={shown ? `Hide ${String(label).toLowerCase()}` : `Show ${String(label).toLowerCase()}`}
            aria-pressed={shown}
            aria-controls={id}
            onClick={() => setShown((value) => !value)}
          >
            {shown ? <EyeOff /> : <Eye />}
          </button>
        ) : null}
      </div>
      {hint ? (
        <span id={hintId} className="au-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <p id={errorId} className="au-field-error">
          <OctagonX />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
});

/**
 * Full-width golden-white submit (h-12, 8 px, 14 px 600, chevron that nudges
 * 4 px on hover). Disabled-with-reason keeps the button focusable
 * (aria-disabled, no submit) and shows the reason as visible text tied by
 * aria-describedby. Loading = aria-busy + spinner, no activation.
 */
export function AuthSubmit({ children, loading = false, disabled = false, disabledReason = "", type = "submit", onClick, className = "", ...rest }) {
  const reasonId = useId();
  const inactive = disabled || loading;
  const block = (event) => {
    event.preventDefault();
  };
  return (
    <>
      <button
        type={inactive ? "button" : type}
        className={`au-submit ${className}`.trim()}
        aria-disabled={disabled ? "true" : undefined}
        aria-busy={loading ? "true" : undefined}
        aria-describedby={disabled && disabledReason ? reasonId : undefined}
        onClick={inactive ? block : onClick}
        {...rest}
      >
        {loading ? <span className="au-spinner" aria-hidden="true" /> : null}
        <span>{children}</span>
        <ChevronRight className="au-submit__chev" />
      </button>
      {disabled && disabledReason ? (
        <p id={reasonId} className="au-reason">
          <Info />
          <span>{disabledReason}</span>
        </p>
      ) : null}
    </>
  );
}

const MESSAGE_ICONS = { error: OctagonX, warning: TriangleAlert, info: Info, success: CheckCircle };

/**
 * Inline message: icon + text + luminance (no hue). `error` is the inverse
 * surface and is announced assertively (role="alert"); the others are polite.
 */
export function AuthMessage({ tone = "info", children, className = "" }) {
  const Icon = MESSAGE_ICONS[tone] || Info;
  const role = tone === "error" ? "alert" : "status";
  return (
    <div className={`au-msg au-msg--${tone} ${className}`.trim()} role={role}>
      <Icon />
      <div>{children}</div>
    </div>
  );
}

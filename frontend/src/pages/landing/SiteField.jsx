import { useId } from "react";

/**
 * A Carbon text input on the site tokens for the public forms (Login,
 * Contact): visible label, 48 px, square, bottom rule, white focus ring.
 * `as="textarea"` for multi-line input. Styles live in sitePages.css.
 */
export default function SiteField({ label, hint, as: Element = "input", className, ...props }) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={className ? `sp-field ${className}` : "sp-field"}>
      <label className="sp-field__label" htmlFor={id}>
        {label}
      </label>
      <Element id={id} className="sp-field__input" aria-describedby={hint ? hintId : undefined} {...props} />
      {hint ? (
        <span id={hintId} className="sp-field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

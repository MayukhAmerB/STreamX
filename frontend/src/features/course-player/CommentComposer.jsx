import { Send } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { COMMENT_MAX_LENGTH, commentCounterText } from "./engagementState";
import { avatarTone, getInitials } from "./formatters";

const MAX_TEXTAREA_HEIGHT_PX = 160;

export function Avatar({ name, seed, size = "md" }) {
  return (
    <span className={`cp-avatar cp-avatar--${size} cp-avatar--tone-${avatarTone(seed ?? name)}`} aria-hidden="true">
      {getInitials(name)}
    </span>
  );
}

/**
 * Comment text box.
 *  - "inline": desktop, YouTube style (avatar, buttons appear while writing)
 *  - "docked": phone bottom bar (text box + send button, like a chat app)
 *  - "edit":   editing an existing comment in place
 * `onSubmit(body)` resolves true when the comment was accepted; the text is
 * cleared immediately (optimistic) and restored if posting fails.
 */
const CommentComposer = forwardRef(function CommentComposer(
  {
    variant = "inline",
    initialValue = "",
    onSubmit,
    onCancel,
    author,
    placeholder = "Add a comment…",
    submitLabel = "Comment",
    autoFocus = false,
  },
  ref
) {
  const [value, setValue] = useState(initialValue);
  const [active, setActive] = useState(Boolean(initialValue) || autoFocus);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef(null);
  const counterId = useId();
  const inputId = useId();

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus?.() }), []);

  // Grow with the text, up to a few lines, then scroll.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element?.style || typeof element.scrollHeight !== "number") return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus?.();
  }, [autoFocus]);

  const trimmed = value.trim();
  const tooLong = value.length > COMMENT_MAX_LENGTH;
  const counter = commentCounterText(value);
  const canSubmit = Boolean(trimmed) && !tooLong && !busy && (variant !== "edit" || trimmed !== initialValue.trim());

  const submit = async () => {
    if (!canSubmit || typeof onSubmit !== "function") return;
    const body = value;
    setBusy(true);
    if (variant !== "edit") setValue("");
    try {
      const ok = await onSubmit(body);
      if (!ok && variant !== "edit") setValue((current) => current || body);
      if (ok && variant === "inline") setActive(false);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setValue(variant === "edit" ? initialValue : "");
    setActive(false);
    onCancel?.();
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && variant === "edit") {
      event.preventDefault();
      cancel();
    }
  };

  const label = variant === "edit" ? "Edit your comment" : "Add a comment";

  return (
    <form
      className={`cp-composer cp-composer--${variant}${active || value ? " is-active" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {variant === "inline" && author ? <Avatar name={author.display_name} seed={author.id} /> : null}
      <div className="cp-composer__field">
        <label htmlFor={inputId} className="cds--visually-hidden">
          {label}
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          className={`cp-composer__input${tooLong ? " is-invalid" : ""}`}
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-invalid={tooLong ? "true" : undefined}
          aria-describedby={counter ? counterId : undefined}
          onChange={(event) => setValue(event.target.value)}
          onFocus={() => setActive(true)}
          onKeyDown={handleKeyDown}
        />
        {counter ? (
          <span id={counterId} className={`cp-composer__counter${tooLong ? " is-invalid" : ""}`} aria-live="polite">
            {counter}
          </span>
        ) : null}
        {variant !== "docked" && (active || value) ? (
          <div className="cp-composer__actions">
            <Button kind="ghost" size="md" type="button" onClick={cancel}>
              Cancel
            </Button>
            <Button kind="primary" size="md" type="submit" disabled={!canSubmit}>
              {variant === "edit" ? "Save" : submitLabel}
            </Button>
          </div>
        ) : null}
      </div>
      {variant === "docked" ? (
        <button type="submit" className="cp-composer__send" aria-label="Post comment" disabled={!canSubmit}>
          <Send size={20} aria-hidden="true" />
        </button>
      ) : null}
    </form>
  );
});

export default CommentComposer;

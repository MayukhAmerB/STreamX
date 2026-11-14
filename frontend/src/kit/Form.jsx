// Form controls (PHILOSOPHY §2.7 sign-in fields, T6). OWNER: WS-KIT.
//
// - UnderlineField: the sign-in look (underline only, 11px label above, golden
//   underline on focus, optional password reveal with a labelled button).
// - Input / Textarea / Select: boxed fields on #0a0a0a with a white/18 hairline.
// - Checkbox, Switch (Radix): white when on, never green.
// - Field: label + control + hint + error (announced politely, never red:
//   an alert icon, the word and a dashed underline carry the error).
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cloneElement, forwardRef, isValidElement, useId, useState } from "react";

import { Alert, Check, ChevronDown, Eye, EyeOff, Minus } from "./icons";
import { cn } from "./lib/cn";

export const Label = forwardRef(function Label({ className, size = "md", ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn(size === "sm" ? "text-label text-subtle" : "text-sm font-medium text-white/[.82]", "peer-disabled:opacity-60", className)}
      {...props}
    />
  );
});

const boxed =
  "w-full rounded-md border border-white/[.18] bg-card px-3 text-sm text-white placeholder:text-placeholder transition-colors duration-150 " +
  "hover:border-white/30 focus-visible:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-dashed aria-[invalid=true]:border-white";

export const Input = forwardRef(function Input({ className, type = "text", ...props }, ref) {
  return <input ref={ref} type={type} className={cn(boxed, "h-11", className)} {...props} />;
});

export const Textarea = forwardRef(function Textarea({ className, rows = 4, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(boxed, "min-h-24 py-2.5 leading-6", className)} {...props} />;
});

/** Native select (keyboard and mobile pickers for free), styled. */
export const Select = forwardRef(function Select({ className, children, ...props }, ref) {
  return (
    <span className="relative block">
      <select ref={ref} className={cn(boxed, "h-11 appearance-none pr-9", className)} {...props}>
        {children}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
});

/**
 * <Field label="Email" hint error> <Input /> </Field>
 * Wires id, aria-describedby and aria-invalid onto the single child control.
 */
export function Field({ label, hint, error, children, className, labelSize = "md", id: givenId }) {
  const autoId = useId();
  const id = givenId || `${autoId}-field`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: children.props.id || id,
        "aria-describedby": [children.props["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined,
        "aria-invalid": error ? true : children.props["aria-invalid"],
      })
    : children;
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {label ? (
        <Label htmlFor={children?.props?.id || id} size={labelSize}>
          {label}
        </Label>
      ) : null}
      {control}
      {hint ? (
        <p id={hintId} className="text-xs leading-5 text-subtle">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}

/** Error line: alert icon + text, polite live region (rendered even when empty so updates are announced). */
export function FieldError({ id, children, className }) {
  return (
    <p id={id} aria-live="polite" className={cn("flex items-start gap-1.5 text-xs leading-5 text-white", !children && "sr-only", className)}>
      {children ? <Alert size={14} className="mt-0.5 shrink-0" /> : null}
      {children}
    </p>
  );
}

/**
 * Sign-in field: 11px label, underline-only input, golden underline on focus.
 * `type="password"` adds a labelled show/hide toggle on the right.
 */
export const UnderlineField = forwardRef(function UnderlineField(
  { label, type = "text", error, hint, className, inputClassName, id: givenId, revealLabel = "Show password", hideLabel = "Hide password", ...props },
  ref
) {
  const autoId = useId();
  const id = givenId || `${autoId}-uf`;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";
  const errorId = `${id}-error`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-label text-subtle">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={id}
          type={isPassword && revealed ? "text" : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(" ") || undefined}
          className={cn("underline-field", isPassword && "pr-10", inputClassName)}
          {...props}
        />
        {isPassword ? (
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-pressed={revealed}
            aria-label={revealed ? hideLabel : revealLabel}
            className="absolute right-0 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-md text-subtle transition-colors duration-150 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-xs text-subtle">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
});

export const Checkbox = forwardRef(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-white/35 bg-transparent transition-colors duration-150",
        "data-[state=checked]:border-white data-[state=checked]:bg-white data-[state=checked]:text-black",
        "data-[state=indeterminate]:border-white data-[state=indeterminate]:bg-white data-[state=indeterminate]:text-black",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {props.checked === "indeterminate" ? <Minus size={12} strokeWidth={2.5} /> : <Check size={12} strokeWidth={2.5} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

/** Switch: off = white/18 track, on = white track with a black thumb (no green). */
export const Switch = forwardRef(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-white/25 bg-white/[.08] p-0.5 transition-colors duration-150",
        "data-[state=checked]:border-white data-[state=checked]:bg-white",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[18px] rounded-full bg-white/80 transition-transform duration-150 ease-standard motion-reduce:transition-none",
          "data-[state=checked]:translate-x-5 data-[state=checked]:bg-black"
        )}
      />
    </SwitchPrimitive.Root>
  );
});

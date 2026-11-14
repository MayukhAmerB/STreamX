// Underline field (PHILOSOPHY §3.2 `.underline-field`): an 11 px label, a
// transparent input on a white/35 bottom rule that turns golden white on
// focus, a muted hint and an error line (icon + text, never hue).
export default function FormInput({
  label,
  error,
  hint,
  as = "input",
  className = "",
  ...props
}) {
  const Component = as;
  return (
    <label className={`block ${className}`}>
      {label ? (
        <span className="mb-1 block text-[11px] font-medium leading-4 text-[#8a8a8a]">
          {label}
        </span>
      ) : null}
      <Component
        className="min-h-11 w-full rounded-none border-0 border-b border-white/35 bg-transparent px-0 py-2.5 text-base text-white placeholder:text-[#737373] transition-[border-color,box-shadow] duration-150 focus:border-[#F3E2B3] focus:shadow-[0_1px_0_0_#F3E2B3] focus:outline-none sm:min-h-10 sm:text-sm"
        aria-invalid={error ? "true" : undefined}
        {...props}
      />
      {hint ? <span className="mt-1.5 block text-xs text-[#8a8a8a]">{hint}</span> : null}
      {error ? (
        <span className="mt-1.5 flex items-start gap-1.5 text-xs text-[#fafafa]">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0">
            <path d="M5.5 1.5h5l4 4v5l-4 4h-5l-4-4v-5Z" fill="currentColor" />
            <path d="m6 6 4 4m0-4-4 4" stroke="#000" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {error}
        </span>
      ) : null}
    </label>
  );
}

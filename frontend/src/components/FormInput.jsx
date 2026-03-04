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
        <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#aeb8a3]">
          {label}
        </span>
      ) : null}
      <Component
        className="w-full rounded-xl border border-[#2a332d] bg-[#0f1310] px-3.5 py-2.5 text-sm text-white placeholder:text-[#7f8b7c] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] focus:border-[#b9c7ab] focus:outline-none focus:ring-2 focus:ring-[#b9c7ab]/20"
        {...props}
      />
      {hint ? <span className="mt-1.5 block text-xs text-[#8e9987]">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-red-400">{error}</span> : null}
    </label>
  );
}


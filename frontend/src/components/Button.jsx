export default function Button({
  children,
  variant = "primary",
  loading = false,
  className = "",
  ...props
}) {
  const variants = {
    primary:
      "border border-white bg-white text-black shadow-none hover:border-[#E5E5E5] hover:bg-[#E5E5E5]",
    secondary:
      "border border-white/15 bg-[#0A0A0A] text-white hover:border-white/35 hover:bg-[#111111]",
    indigo:
      "border border-white bg-white text-black shadow-none hover:border-[#E5E5E5] hover:bg-[#E5E5E5]",
    indigoSoft:
      "border border-white/25 bg-white/[0.08] text-white hover:border-white/45 hover:bg-white/[0.12]",
    danger: "border border-red-400/40 bg-red-600 text-white hover:bg-red-500",
    ghost: "border border-white/20 bg-transparent text-white hover:bg-white/10",
  };

  return (
    <button
      className={`inline-flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold tracking-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? "Loading..." : children}
    </button>
  );
}


export default function Button({
  children,
  variant = "primary",
  loading = false,
  className = "",
  ...props
}) {
  const variants = {
    primary:
      "border border-[#d2dcc7] bg-gradient-to-r from-[#d6dfcb] to-[#a6b899] text-[#101410] shadow-[0_10px_24px_rgba(55,68,52,0.25)] hover:from-[#e2e8db] hover:to-[#b8c7ad]",
    secondary:
      "border border-[#2e372f] bg-[#111612] text-[#dce4d2] backdrop-blur hover:bg-[#161d17]",
    indigo:
      "border border-[#d2dcc7] bg-gradient-to-r from-[#d8e0cd] to-[#b2c1a5] text-[#101410] hover:from-[#e5eadf] hover:to-[#bfccb4]",
    indigoSoft:
      "border border-[#cfd8c5] bg-[#eef2ea] text-[#243025] hover:bg-[#f6f8f2]",
    danger: "border border-red-400/40 bg-red-600 text-white hover:bg-red-500",
    ghost: "border border-white/20 bg-transparent text-white hover:bg-white/10",
  };

  return (
    <button
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold tracking-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b9c7ab]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050705] disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? "Loading..." : children}
    </button>
  );
}


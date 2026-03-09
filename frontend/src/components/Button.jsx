export default function Button({
  children,
  variant = "primary",
  loading = false,
  className = "",
  ...props
}) {
  const variants = {
    primary:
      "border border-[#D7D7D7] bg-gradient-to-r from-[#DADADA] to-[#AFAFAF] text-[#121212] shadow-[0_10px_24px_rgba(62,62,62,0.25)] hover:from-[#E5E5E5] hover:to-[#C0C0C0]",
    secondary:
      "border border-black bg-[#141414] text-[#E0E0E0] backdrop-blur hover:bg-[#1A1A1A]",
    indigo:
      "border border-[#D7D7D7] bg-gradient-to-r from-[#DBDBDB] to-[#B9B9B9] text-[#121212] hover:from-[#E7E7E7] hover:to-[#C5C5C5]",
    indigoSoft:
      "border border-[#D3D3D3] bg-[#F0F0F0] text-[#2B2B2B] hover:bg-[#F7F7F7]",
    danger: "border border-red-400/40 bg-red-600 text-white hover:bg-red-500",
    ghost: "border border-white/20 bg-transparent text-white hover:bg-white/10",
  };

  return (
    <button
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold tracking-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C0C0C0]/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? "Loading..." : children}
    </button>
  );
}


import { siteBrand } from "../config/siteBrand";

// HackPath-style buttons on the palette law (PHILOSOPHY §2.7 "Buttons"):
// a solid white rectangle for the primary action, a white/20 outline for the
// secondary one, 8 px corners, 14 px medium text, 150 ms colour changes and
// the golden-white focus ring. No hue: "danger" is a strong outline that
// inverts on hover (the label says what it does).
export const BUTTON_VARIANTS = {
  primary: "border border-white bg-white text-black hover:border-white/90 hover:bg-white/90",
  secondary: "border border-white/20 bg-transparent text-white hover:bg-white/[0.08]",
  indigo: "border border-white bg-white text-black hover:border-white/90 hover:bg-white/90",
  indigoSoft: "border border-white/25 bg-white/[0.06] text-white hover:border-white/40 hover:bg-white/[0.1]",
  danger: "border border-white/60 bg-transparent text-white hover:bg-white hover:text-black",
  ghost: "border border-white/10 bg-transparent text-white hover:bg-white/[0.08]",
};

export default function Button({
  children,
  variant = "primary",
  loading = false,
  className = "",
  ...props
}) {
  return (
    <button
      className={`inline-flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-md px-5 py-2.5 text-sm font-medium transition-colors duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F3E2B3] disabled:cursor-not-allowed disabled:border-dashed disabled:border-white/25 disabled:bg-white/[0.06] disabled:text-[#a1a1a1] ${siteBrand.id === "owlcognito" ? "owlcognito-button" : ""} ${BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? "Loading..." : children}
    </button>
  );
}

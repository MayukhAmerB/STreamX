import { useContext } from "react";
import { siteBrand } from "../config/siteBrand";
import { ButtonSurfaceContext } from "./buttonSurface";

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

// The public website's buttons (Friday 13 Nov look), used inside AppLayout.
const WEBSITE_VARIANTS = {
  primary: "border border-white bg-white text-black shadow-none hover:border-[#E5E5E5] hover:bg-[#E5E5E5]",
  secondary: "border border-white/15 bg-[#0A0A0A] text-white hover:border-white/35 hover:bg-[#111111]",
  indigo: "border border-white bg-white text-black shadow-none hover:border-[#E5E5E5] hover:bg-[#E5E5E5]",
  indigoSoft: "border border-white/25 bg-white/[0.08] text-white hover:border-white/45 hover:bg-white/[0.12]",
  danger: "border border-red-400/40 bg-red-600 text-white hover:bg-red-500",
  ghost: "border border-white/20 bg-transparent text-white hover:bg-white/10",
};

const WEBSITE_BASE =
  "inline-flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold tracking-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-60";

const CONSOLE_BASE =
  "inline-flex min-h-11 touch-manipulation items-center justify-center gap-2 rounded-md px-5 py-2.5 text-sm font-medium transition-colors duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F3E2B3] disabled:cursor-not-allowed disabled:border-dashed disabled:border-white/25 disabled:bg-white/[0.06] disabled:text-[#a1a1a1]";

export default function Button({
  children,
  variant = "primary",
  loading = false,
  className = "",
  ...props
}) {
  const website = useContext(ButtonSurfaceContext) === "website";
  const base = website ? WEBSITE_BASE : CONSOLE_BASE;
  const variants = website ? WEBSITE_VARIANTS : BUTTON_VARIANTS;
  return (
    <button
      className={`${base} ${siteBrand.id === "owlcognito" ? "owlcognito-button" : ""} ${variants[variant] || variants.primary} ${className}`}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? "Loading..." : children}
    </button>
  );
}

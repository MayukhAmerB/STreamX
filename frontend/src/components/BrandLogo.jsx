import { Link } from "react-router-dom";

export default function BrandLogo({ to = "/", className = "" }) {
  return (
    <Link to={to} className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/25 bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]">
        <svg
          viewBox="0 0 32 32"
          aria-hidden="true"
          className="h-5.5 w-5.5"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M16 3.5l10 4v8.5c0 6.2-4.1 10.8-10 12.5C10.1 26.8 6 22.2 6 16V7.5l10-4z"
            fill="url(#shield)"
            stroke="rgba(255,255,255,0.75)"
            strokeWidth="1"
          />
          <path
            d="M16 9l4.9 12h-2.7l-.9-2.4h-4.6l-.9 2.4H9.1L14 9h2zm.5 7.6L15 12.6l-1.5 4h3z"
            fill="white"
          />
          <defs>
            <linearGradient id="shield" x1="6" y1="4" x2="26" y2="28.5" gradientUnits="userSpaceOnUse">
              <stop stopColor="#DCE5D1" />
              <stop offset="0.55" stopColor="#AABA9D" />
              <stop offset="1" stopColor="#5C6D54" />
            </linearGradient>
          </defs>
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-[17px] font-semibold tracking-tight text-white">
          AlsyedAcademy
        </span>
        <span className="block text-[10px] uppercase tracking-[0.18em] text-[#d6dfcb]/70">
          Cybersecurity Platform
        </span>
      </span>
    </Link>
  );
}

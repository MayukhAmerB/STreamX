import { Link } from "react-router-dom";

export default function BrandLogo({ to = "/", className = "" }) {
  return (
    <Link to={to} className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="relative inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-full">
        <img
          src="/logo.jpeg"
          alt="Al syed Initiative logo"
          className="h-full w-full object-contain"
          loading="lazy"
          decoding="async"
        />
      </span>
      <span className="leading-tight">
        <span className="block text-[17px] font-semibold tracking-tight text-white">
          Al syed Initiative
        </span>
        <span className="block text-[10px] uppercase tracking-[0.18em] text-[#d6dfcb]/70">
          Cybersecurity Platform
        </span>
      </span>
    </Link>
  );
}


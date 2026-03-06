import { Link } from "react-router-dom";

export default function BrandLogo({ to = "/", className = "" }) {
  return (
    <Link to={to} className={`inline-flex max-w-full items-center gap-2.5 ${className}`}>
      <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full sm:h-11 sm:w-11">
        <img
          src="/logo.jpeg"
          alt="Al syed Initiative logo"
          className="h-full w-full object-contain"
          loading="lazy"
          decoding="async"
        />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[15px] font-semibold tracking-tight text-white sm:text-[17px]">
          Al syed Initiative
        </span>
        <span className="hidden text-[10px] uppercase tracking-[0.18em] text-[#d6dfcb]/70 sm:block">
          Cybersecurity Platform
        </span>
      </span>
    </Link>
  );
}


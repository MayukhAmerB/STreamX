import { Link } from "react-router-dom";
import { siteBrand } from "../config/siteBrand";
import OwlCognitoMark from "./OwlCognitoMark";

export default function BrandLogo({ to = "/", className = "" }) {
  const isOwlCognito = siteBrand.id === "owlcognito";

  return (
    <Link to={to} className={`inline-flex max-w-full items-center gap-2.5 ${className}`}>
      <span
        className={`relative inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md sm:h-11 sm:w-11 ${
          isOwlCognito
            ? "border border-[#6d28d9]/25 bg-[#f0ebff] text-[#5b21b6] shadow-[0_8px_18px_rgba(109,40,217,0.16)]"
            : ""
        }`}
      >
        {isOwlCognito ? (
          <OwlCognitoMark className="h-8 w-8 sm:h-9 sm:w-9" />
        ) : (
          <img
            src="/logo.jpeg"
            alt="Al syed Initiative logo"
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
          />
        )}
      </span>
      <span className="min-w-0 leading-tight">
        <span className={`block truncate text-[15px] font-semibold tracking-tight sm:text-[17px] ${isOwlCognito ? "text-[#18131d]" : "text-white"}`}>
          {siteBrand.name}
        </span>
        <span className={`hidden text-[10px] uppercase tracking-[0.18em] sm:block ${isOwlCognito ? "text-[#2d2534]" : "text-[#DADADA]/70"}`}>
          {siteBrand.platformLabel}
        </span>
      </span>
    </Link>
  );
}


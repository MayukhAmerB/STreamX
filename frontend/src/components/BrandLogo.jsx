import "./BrandLogo.css";

import { Link } from "react-router-dom";
import { siteBrand } from "../config/siteBrand";
import OwlCognitoMark from "./OwlCognitoMark";

/**
 * Brand lock-up. `variant="shell"` is the Syed Carbon header/footer version
 * (token colours, works on the g100 shell for both brands); the default keeps
 * the previous look for pages that still use it (e.g. the login page).
 */
export default function BrandLogo({ to = "/", className = "", variant = "default", showLabel = true }) {
  const isOwlCognito = siteBrand.id === "owlcognito";

  if (variant === "shell") {
    return (
      <Link to={to} className={`brand-shell ${className}`.trim()}>
        <span className="brand-shell__mark" aria-hidden={isOwlCognito ? undefined : "true"}>
          {isOwlCognito ? (
            <OwlCognitoMark className="brand-shell__owl" />
          ) : (
            <img src="/logo-256.webp" alt="" width="256" height="256" decoding="async" />
          )}
        </span>
        <span className="brand-shell__text">
          <span className="brand-shell__name">{siteBrand.name}</span>
          {showLabel ? <span className="brand-shell__label">{siteBrand.platformLabel}</span> : null}
        </span>
      </Link>
    );
  }

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
            src="/logo-256.webp"
            alt="Al syed Initiative logo"
            width="256"
            height="256"
            className="h-full w-full object-contain"
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

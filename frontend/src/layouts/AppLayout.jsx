import { useEffect, useLayoutEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import AppFooter from "../components/AppFooter";
import { ButtonSurfaceContext } from "../components/buttonSurface";
import GlobalPageBackground from "../components/GlobalPageBackground";
import Navbar from "../components/Navbar";
import SafeRender from "../components/SafeRender";
import TermsGate from "../components/TermsGate";
import { applyPageMeta } from "../config/pageMeta";
import { siteBrand } from "../config/siteBrand";
// The 13ca6b79 public pages (course detail, payment, login, terms, pricing,
// monthly CTF, profiles, certificates, 404 ...) use the hp-* design language.
import "../marketing/hp.css";

/**
 * Hybrid release (owner, Nov 2026): the Friday 13 Nov website is the landing
 * page and the pages its navbar links to. Every other public page stays the
 * 13ca6b79 version and renders inside its own "site-public hp" surface, with
 * the Friday navbar and footer around it.
 */
export const FRIDAY_WEBSITE_PATHS = new Set([
  "/",
  "/courses",
  "/watch",
  "/about",
  "/national-desk",
  "/contact",
  "/faqs",
  "/as-accounts",
  "/join-alsyed",
  "/hall-of-fame",
  // Task C: the public reward-system page, styled like the Friday site.
  "/rewards",
]);

export function isFridayWebsitePath(pathname = "/") {
  const path = String(pathname || "/").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return FRIDAY_WEBSITE_PATHS.has(path);
}

export default function AppLayout() {
  const isOwlCognito = siteBrand.id === "owlcognito";
  const { pathname } = useLocation();
  const friday = isFridayWebsitePath(pathname);

  // Hybrid release: marks <html> as the Friday website (0.9 zoom, Inter
  // headings in index.css); the Console never sets it.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.surface = "website";
    return () => {
      delete root.dataset.surface;
    };
  }, []);

  useEffect(() => {
    applyPageMeta(pathname);
  }, [pathname]);

  return (
    <ButtonSurfaceContext.Provider value="website">
    <div
      className={`relative min-h-screen ${
        isOwlCognito
          ? "owlcognito-app-shell bg-[#fbfaff] text-[#241344]"
          : "bg-black text-white"
      }`}
    >
      <SafeRender fallback={null}>
        <GlobalPageBackground />
      </SafeRender>
      <div className="relative z-10">
        <Navbar />
        <main className="relative">
          {friday ? (
            <Outlet />
          ) : (
            <ButtonSurfaceContext.Provider value="latest">
              <div className="site-public hp hybrid-latest" data-theme="g100" data-site-layout={siteBrand.id}>
                <Outlet />
              </div>
            </ButtonSurfaceContext.Provider>
          )}
        </main>
        <AppFooter />
        <TermsGate />
      </div>
    </div>
    </ButtonSurfaceContext.Provider>
  );
}

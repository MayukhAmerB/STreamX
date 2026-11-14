import { useEffect, useLayoutEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import AppFooter from "../components/AppFooter";
import GlobalPageBackground from "../components/GlobalPageBackground";
import Navbar from "../components/Navbar";
import SafeRender from "../components/SafeRender";
import TermsGate from "../components/TermsGate";
import { applyPageMeta } from "../config/pageMeta";
import { siteBrand } from "../config/siteBrand";
// HackPath-philosophy design language for every public page (black canvas,
// Geist, white in luminance steps, one golden-white accent; hp-* classes).
import "../marketing/hp.css";

export default function AppLayout() {
  const { pathname } = useLocation();

  // Public surface marker on <html>: body-level portals (enquiry modal, toasts)
  // inherit the website font too (src/styles/site-theme.css).
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.surface = "public";
    return () => {
      delete root.dataset.surface;
    };
  }, []);

  useEffect(() => {
    applyPageMeta(pathname);
  }, [pathname]);

  // One monochrome system for both brands (BUILD_PLAN D11, owner question Q3
  // default): black canvas, white text and the dark (g100) site-kit theme.
  return (
    <div className="site-public hp relative min-h-screen bg-black text-white" data-theme="g100" data-site-layout={siteBrand.id}>
      <SafeRender fallback={null}>
        <GlobalPageBackground />
      </SafeRender>
      <div className="relative z-10">
        <Navbar />
        <main className="relative">
          <Outlet />
        </main>
        <AppFooter />
        <TermsGate />
      </div>
    </div>
  );
}

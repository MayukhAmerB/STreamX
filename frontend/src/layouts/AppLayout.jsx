import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import AppFooter from "../components/AppFooter";
import GlobalPageBackground from "../components/GlobalPageBackground";
import Navbar from "../components/Navbar";
import PublicEnrollmentRequestModal from "../components/PublicEnrollmentRequestModal";
import SafeRender from "../components/SafeRender";
import TermsGate from "../components/TermsGate";
import {
  LANDING_PUBLIC_ENROLLMENT_PROMPT_EVENT,
  shouldHandlePublicEnrollmentPromptInLayout,
} from "../utils/publicEnrollmentPrompt";

export default function AppLayout() {
  const location = useLocation();
  const [publicLeadTarget, setPublicLeadTarget] = useState(null);

  useEffect(() => {
    const openEnrollmentPrompt = (event) => {
      if (!shouldHandlePublicEnrollmentPromptInLayout(location.pathname)) return;
      setPublicLeadTarget(event.detail || { type: "general" });
    };

    window.addEventListener(LANDING_PUBLIC_ENROLLMENT_PROMPT_EVENT, openEnrollmentPrompt);
    return () => {
      window.removeEventListener(LANDING_PUBLIC_ENROLLMENT_PROMPT_EVENT, openEnrollmentPrompt);
    };
  }, [location.pathname]);

  useEffect(() => {
    setPublicLeadTarget(null);
  }, [location.pathname]);

  return (
    <div className="relative min-h-screen bg-black text-white">
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
        <PublicEnrollmentRequestModal
          isOpen={Boolean(publicLeadTarget)}
          onClose={() => setPublicLeadTarget(null)}
          targetType={publicLeadTarget?.type}
          targetId={publicLeadTarget?.id}
          targetName={publicLeadTarget?.title}
          sourcePath={`${location.pathname}${location.search}`}
          loginPath="/login"
        />
      </div>
    </div>
  );
}

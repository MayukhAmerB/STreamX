import { Outlet } from "react-router-dom";
import AppFooter from "../components/AppFooter";
import GlobalPageBackground from "../components/GlobalPageBackground";
import Navbar from "../components/Navbar";
import SafeRender from "../components/SafeRender";
import TermsGate from "../components/TermsGate";
import { siteBrand } from "../config/siteBrand";

export default function AppLayout() {
  const isOwlCognito = siteBrand.id === "owlcognito";

  return (
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
          <Outlet />
        </main>
        <AppFooter />
        <TermsGate />
      </div>
    </div>
  );
}

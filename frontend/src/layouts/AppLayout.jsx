import { Outlet } from "react-router-dom";
import AppFooter from "../components/AppFooter";
import GlobalPageBackground from "../components/GlobalPageBackground";
import Navbar from "../components/Navbar";

export default function AppLayout() {
  return (
    <div className="relative min-h-screen bg-black text-white">
      <GlobalPageBackground />
      <div className="relative z-10">
        <Navbar />
        <main className="relative">
          <Outlet />
        </main>
        <AppFooter />
      </div>
    </div>
  );
}

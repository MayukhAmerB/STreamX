import { Outlet } from "react-router-dom";
import Navbar from "../components/Navbar";

export default function AppLayout() {
  return (
    <div className="min-h-screen bg-[#050705] text-white">
      <Navbar />
      <main className="relative">
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 opacity-95">
          <div className="absolute inset-0 bg-[url('https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg')] bg-cover bg-center opacity-[0.18]" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_12%_8%,rgba(185,199,171,0.14),transparent_45%),radial-gradient(circle_at_88%_14%,rgba(255,255,255,0.03),transparent_38%),linear-gradient(180deg,#0a0d0a,#060806_42%,#040604)]" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(117,133,104,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(117,133,104,0.05)_1px,transparent_1px)] bg-[size:28px_28px]" />
        </div>
        <Outlet />
      </main>
    </div>
  );
}

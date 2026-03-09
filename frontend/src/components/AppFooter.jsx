import { Link } from "react-router-dom";
import BrandLogo from "./BrandLogo";

const quickLinks = [
  { label: "Home", to: "/" },
  { label: "Courses", to: "/courses" },
  { label: "Live Classes", to: "/live-classes" },
  { label: "Join Live", to: "/join-live" },
];

const programLinks = [
  { label: "OSINT Tracks", to: "/courses" },
  { label: "Web Pentesting Tracks", to: "/courses" },
  { label: "Live Weekend Batches", to: "/live-classes" },
  { label: "Instructor Sessions", to: "/meeting" },
];
const footerBackgroundImage =
  "https://i.pinimg.com/1200x/76/04/ac/7604ac8e2f6f49a78ea840886c9f5ba7.jpg";

function FooterLink({ to, label }) {
  return (
    <Link
      to={to}
      className="rounded-md px-1 py-1 text-sm text-[#d3dcc9] transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b9c7ab]/60"
    >
      {label}
    </Link>
  );
}

export default function AppFooter() {
  const year = new Date().getFullYear();

  return (
    <footer
      id="contact"
      className="relative mt-14 overflow-hidden border-t border-[#d2dcc6]/12 bg-[#060806] text-[#f5f7f1]"
    >
      <div className="absolute inset-0">
        <img
          src={footerBackgroundImage}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover opacity-[0.52]"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/[0.68] via-black/[0.52] to-[#040604]/[0.7]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 py-10 sm:py-12">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.2fr_0.9fr_0.9fr_1fr]">
          <section className="rounded-2xl border border-[#2a332d] bg-[#0d120f]/90 p-5 shadow-[0_12px_30px_rgba(0,0,0,0.26)]">
            <BrandLogo />
            <p className="mt-4 max-w-md text-sm leading-6 text-[#b7c0b0]">
              Enterprise-focused cybersecurity learning with structured courses, live classes, and
              practical workflow training.
            </p>
          </section>

          <section className="rounded-2xl border border-[#2a332d] bg-[#0d120f]/90 p-5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8f9989]">Quick Links</h3>
            <div className="mt-3 grid gap-1">
              {quickLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-[#2a332d] bg-[#0d120f]/90 p-5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8f9989]">Programs</h3>
            <div className="mt-3 grid gap-1">
              {programLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-[#c5ccbf]/22 bg-gradient-to-br from-[#111412] via-[#171b18] to-[#1d231f] p-5 shadow-[0_14px_34px_rgba(0,0,0,0.24)]">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#d7e0cc]">Support</h3>
            <p className="mt-3 text-sm leading-6 text-[#d3dcc9]">
              Need help with enrollment, live classes, or account setup?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Link
                to="/contact"
                className="inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-[#c9d5bd] to-[#8fa184] px-4 py-2 text-sm font-semibold text-[#101410] transition hover:from-[#d7e0cc] hover:to-[#9daf93]"
              >
                Contact Support
              </Link>
              <Link
                to="/about"
                className="inline-flex w-full items-center justify-center rounded-full border border-[#3a463b] bg-[#121812] px-4 py-2 text-sm font-semibold text-[#d7e0cc] transition hover:bg-[#182018]"
              >
                Platform Overview
              </Link>
            </div>
          </section>
        </div>
      </div>

      <div className="relative border-t border-[#d2dcc6]/12">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-2 px-4 py-4 text-center text-xs tracking-[0.12em] text-[#8f9989] sm:justify-between sm:text-left">
          <span>{"\u00A9"} {year} Al syed Initiative. All rights reserved.</span>
          <span>Secure Learning Infrastructure</span>
        </div>
      </div>
    </footer>
  );
}

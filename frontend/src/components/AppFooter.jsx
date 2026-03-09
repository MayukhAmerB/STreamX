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
      className="rounded-md px-1 py-1 text-sm text-[#D7D7D7] transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C0C0C0]/60"
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
      className="relative mt-14 overflow-hidden border-t border-[#D7D7D7]/12 bg-[#070707] text-[#F6F6F6]"
    >
      <div className="absolute inset-0">
        <img
          src={footerBackgroundImage}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover opacity-[0.52]"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/[0.68] via-black/[0.52] to-[#050505]/[0.7]" />
      </div>

      <div className="relative mx-auto max-w-7xl px-4 py-10 sm:py-12">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.2fr_0.9fr_0.9fr_1fr]">
          <section className="rounded-2xl border border-black panel-gradient p-5 shadow-[0_12px_30px_rgba(0,0,0,0.26)]">
            <BrandLogo />
            <p className="mt-4 max-w-md text-sm leading-6 text-[#BBBBBB]">
              Enterprise-focused cybersecurity learning with structured courses, live classes, and
              practical workflow training.
            </p>
          </section>

          <section className="rounded-2xl border border-black panel-gradient p-5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#949494]">Quick Links</h3>
            <div className="mt-3 grid gap-1">
              {quickLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-black panel-gradient p-5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#949494]">Programs</h3>
            <div className="mt-3 grid gap-1">
              {programLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-black bg-gradient-to-br from-[#131313] via-[#191919] to-[#212121] p-5 shadow-[0_14px_34px_rgba(0,0,0,0.24)]">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#DBDBDB]">Support</h3>
            <p className="mt-3 text-sm leading-6 text-[#D7D7D7]">
              Need help with enrollment, live classes, or account setup?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Link
                to="/contact"
                className="inline-flex w-full items-center justify-center rounded-full bg-gradient-to-r from-[#CFCFCF] to-[#989898] px-4 py-2 text-sm font-semibold text-[#121212] transition hover:from-[#DBDBDB] hover:to-[#A6A6A6]"
              >
                Contact Support
              </Link>
              <Link
                to="/about"
                className="inline-flex w-full items-center justify-center rounded-full border border-black bg-[#161616] px-4 py-2 text-sm font-semibold text-[#DBDBDB] transition hover:bg-[#1D1D1D]"
              >
                Platform Overview
              </Link>
            </div>
          </section>
        </div>
      </div>

      <div className="relative border-t border-[#D7D7D7]/12">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-2 px-4 py-4 text-center text-xs tracking-[0.12em] text-[#949494] sm:justify-between sm:text-left">
          <span>{"\u00A9"} {year} Al syed Initiative. All rights reserved.</span>
          <span>Secure Learning Infrastructure</span>
        </div>
      </div>
    </footer>
  );
}

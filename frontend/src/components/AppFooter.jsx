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

const socialLinks = [
  { label: "Instagram", href: "https://www.instagram.com/adl.response", kind: "instagram" },
  { label: "X", href: "https://x.com/AdlFront", kind: "x" },
  { label: "WhatsApp +91 99708 75040", href: "https://wa.me/919970875040", kind: "whatsapp" },
  { label: "WhatsApp +91 9800415583", href: "https://wa.me/919800415583", kind: "whatsapp" },
  { label: "Email", href: "mailto:alsyedinitiative@gmail.com", kind: "email" },
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

function SocialIcon({ kind }) {
  if (kind === "instagram") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
        <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="17" cy="7" r="1.2" fill="currentColor" />
      </svg>
    );
  }

  if (kind === "x") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
        <path d="M6 5l12 14M17.6 5L6.4 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "whatsapp") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
        <path d="M12 4.5a7.5 7.5 0 0 0-6.6 11.1L4.7 19l3.5-.6A7.5 7.5 0 1 0 12 4.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9.7 9.2c-.2-.5-.5-.4-.7-.4h-.3c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2s.8 2.4.9 2.6c.1.2 1.5 2.4 3.7 3.2 1.8.7 2.2.6 2.5.5.4-.1 1.1-.5 1.2-1 .1-.4.1-.8.1-.9-.1-.1-.3-.2-.7-.4s-1.1-.5-1.3-.6c-.2-.1-.4-.1-.5.1-.2.2-.6.6-.7.8-.1.2-.3.2-.5.1-.2-.1-.9-.3-1.6-1-.6-.6-1-1.3-1.2-1.6-.1-.2 0-.3.1-.4l.3-.4.2-.3c.1-.1.1-.3 0-.4l-.7-1.7Z" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M4 7h16v10H4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.8 7.8l7.2 5.6 7.2-5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FooterSocialLink({ href, label, kind }) {
  const isMail = href.startsWith("mailto:");
  return (
    <a
      href={href}
      target={isMail ? undefined : "_blank"}
      rel={isMail ? undefined : "noreferrer"}
      title={label}
      aria-label={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#D7D7D7]/20 bg-[#141414] text-[#D7D7D7] transition hover:border-[#D7D7D7]/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C0C0C0]/60"
    >
      <SocialIcon kind={kind} />
    </a>
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

      <div className="relative mx-auto max-w-7xl px-4 py-7 sm:py-8">
        <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
          <section className="h-full min-h-[220px] rounded-2xl border border-black panel-gradient p-4 shadow-[0_12px_30px_rgba(0,0,0,0.26)]">
            <BrandLogo />
            <p className="mt-3 max-w-md text-sm leading-6 text-[#BBBBBB]">
              Enterprise-focused cybersecurity learning with structured courses, live classes, and
              practical workflow training.
            </p>
          </section>

          <section className="h-full min-h-[220px] rounded-2xl border border-black panel-gradient p-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#949494]">Quick Links</h3>
            <div className="mt-2 grid gap-1">
              {quickLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="h-full min-h-[220px] rounded-2xl border border-black panel-gradient p-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#949494]">Programs</h3>
            <div className="mt-2 grid gap-1">
              {programLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="h-full min-h-[220px] rounded-2xl border border-black bg-gradient-to-br from-[#131313] via-[#191919] to-[#212121] p-4 shadow-[0_14px_34px_rgba(0,0,0,0.24)]">
            <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#DBDBDB]">Support</h3>
            <p className="mt-2 text-sm leading-6 text-[#D7D7D7]">
              Need help with enrollment, live classes, or account setup?
            </p>
            <div className="mt-3 flex flex-col gap-2">
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

        <section className="mt-4 rounded-2xl border border-black bg-gradient-to-br from-[#131313] via-[#191919] to-[#212121] p-4 shadow-[0_14px_34px_rgba(0,0,0,0.24)]">
          <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#DBDBDB]">Connect</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {socialLinks.map((item) => (
              <FooterSocialLink
                key={`${item.kind}-${item.href}`}
                href={item.href}
                label={item.label}
                kind={item.kind}
              />
            ))}
          </div>
        </section>
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

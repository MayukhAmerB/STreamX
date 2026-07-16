import { Link } from "react-router-dom";
import BrandLogo from "./BrandLogo";

const quickLinks = [
  { label: "Home", to: "/" },
  { label: "Courses", to: "/courses" },
  { label: "Live Classes", to: "/live-classes" },
  { label: "Join Live", to: "/join-live" },
  { label: "Terms and Conditions", to: "/terms" },
];

const programLinks = [
  { label: "OSINT Tracks", to: "/courses" },
  { label: "Web Pentesting Tracks", to: "/courses" },
  { label: "Live Weekend Batches", to: "/live-classes" },
  { label: "Instructor Sessions", to: "/meeting" },
];

const socialLinks = [
  {
    label: "Instagram",
    href: "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg==",
    kind: "instagram",
  },
  { label: "X", href: "https://x.com/AdlFront", kind: "x" },
  { label: "WhatsApp +91 99708 75040", href: "https://wa.me/919970875040", kind: "whatsapp" },
  { label: "WhatsApp +91 9800415583", href: "https://wa.me/919800415583", kind: "whatsapp" },
  { label: "Email", href: "mailto:contact@adlfront.com", kind: "email" },
];

function FooterLink({ to, label }) {
  return (
    <Link
      to={to}
      className="group inline-flex min-h-9 items-center gap-2 rounded-md text-sm text-[#A7A7A7] transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <span className="h-px w-3 bg-[#454545] transition-all group-hover:w-5 group-hover:bg-white" aria-hidden="true" />
      {label}
    </Link>
  );
}

function SocialIcon({ kind }) {
  if (kind === "instagram") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0">
        <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="17" cy="7" r="1.2" fill="currentColor" />
      </svg>
    );
  }

  if (kind === "x") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0">
        <path d="M6 5l12 14M17.6 5L6.4 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "whatsapp") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0">
        <path d="M12 4.5a7.5 7.5 0 0 0-6.6 11.1L4.7 19l3.5-.6A7.5 7.5 0 1 0 12 4.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9.7 9.2c-.2-.5-.5-.4-.7-.4h-.3c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2s.8 2.4.9 2.6c.1.2 1.5 2.4 3.7 3.2 1.8.7 2.2.6 2.5.5.4-.1 1.1-.5 1.2-1 .1-.4.1-.8.1-.9-.1-.1-.3-.2-.7-.4s-1.1-.5-1.3-.6c-.2-.1-.4-.1-.5.1-.2.2-.6.6-.7.8-.1.2-.3.2-.5.1-.2-.1-.9-.3-1.6-1-.6-.6-1-1.3-1.2-1.6-.1-.2 0-.3.1-.4l.3-.4.2-.3c.1-.1.1-.3 0-.4l-.7-1.7Z" fill="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0">
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
      className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-white/10 bg-[#0D0D0D] px-3 text-[#BDBDBD] transition hover:border-white/25 hover:bg-[#151515] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <SocialIcon kind={kind} />
      <span className="text-xs font-medium">{label}</span>
    </a>
  );
}

export default function AppFooter() {
  const year = new Date().getFullYear();

  return (
    <footer
      id="contact"
      className="relative mt-10 overflow-hidden border-t border-white/10 bg-[#050505] text-[#F6F6F6] sm:mt-14"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute right-[-10rem] top-[-12rem] h-96 w-96 rounded-full bg-white/[0.035] blur-[110px]" />
        <div className="absolute left-0 top-0 h-px w-full bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      </div>

      <div className="relative mx-auto max-w-6xl px-4 py-9 sm:py-14">
        <div className="grid gap-8 border-b border-white/10 pb-8 sm:grid-cols-2 sm:gap-10 sm:pb-10 lg:grid-cols-12 lg:gap-8">
          <section className="sm:col-span-2 lg:col-span-5 lg:pr-10">
            <BrandLogo />
            <p className="mt-5 max-w-md text-sm leading-7 text-[#969696]">
              Enterprise-focused cybersecurity learning with structured courses, live classes, and
              practical workflow training.
            </p>
            <div className="mt-6 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#777777]">
              <span className="h-px w-8 bg-white/70" aria-hidden="true" />
              Controlled learning access
            </div>
          </section>

          <section className="lg:col-span-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">Explore</h3>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:mt-4 sm:grid-cols-1">
              {quickLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="lg:col-span-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">Programs</h3>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 sm:mt-4 sm:grid-cols-1">
              {programLinks.map((item) => (
                <FooterLink key={item.label} to={item.to} label={item.label} />
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-white/10 bg-[#0B0B0B] p-5 lg:col-span-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">Need support?</h3>
            <p className="mt-3 text-sm leading-6 text-[#969696]">
              Need help with enrollment, live classes, or account setup?
            </p>
            <div className="mt-5 grid gap-2">
              <Link
                to="/contact"
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-white px-4 text-sm font-semibold text-black transition hover:bg-[#E5E5E5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                Contact Support
              </Link>
              <Link
                to="/about"
                className="inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-white/10 bg-[#111111] px-4 text-sm font-semibold text-[#CFCFCF] transition hover:border-white/20 hover:bg-[#171717]"
              >
                Platform Overview
              </Link>
            </div>
          </section>
        </div>

        <section className="pt-7 sm:pt-8">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">Connect</h3>
              <p className="mt-2 text-xs text-[#777777]">Official channels for support and platform updates.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 min-[430px]:flex min-[430px]:flex-wrap">
            {socialLinks.map((item) => (
              <FooterSocialLink
                key={`${item.kind}-${item.href}`}
                href={item.href}
                label={item.label}
                kind={item.kind}
              />
            ))}
            </div>
          </div>
        </section>
      </div>

      <div className="relative border-t border-white/10 bg-black/40">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-5 text-center text-[10px] uppercase tracking-[0.16em] text-[#777777] sm:flex-row sm:text-left">
          <span>{"\u00A9"} {year} Al syed Initiative. All rights reserved.</span>
          <span>Secure Learning Infrastructure</span>
        </div>
      </div>
    </footer>
  );
}

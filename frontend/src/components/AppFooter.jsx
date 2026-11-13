import "./AppFooter.css";

import { useId } from "react";
import { Link, useLocation } from "react-router-dom";
import { siteBrand } from "../config/siteBrand";
import { useYouTubeChannel } from "../features/youtube/youTubeStore";
import BrandLogo from "./BrandLogo";
import { getWatchNavState, LABS_URL, WATCH_EMPTY_REASON } from "./siteNavModel";

const companyLinks = [
  { label: "About Us", to: "/about" },
  { label: "Contact", to: "/contact" },
  { label: "FAQs", to: "/faqs" },
  { label: "Terms", to: "/terms" },
];

/**
 * Phones lay Connect out two cells per row; the email address and an odd
 * last channel take a full row so nothing is cut off and no cell stays empty.
 */
// Phone numbers and the email address need a full row on small phones (never "+91 99708 750…").
const CONTACT_KINDS = new Set(["whatsapp", "email"]);

export function markWideSocialLinks(items) {
  const narrow = items.filter((item) => item.kind !== "email");
  const lastOdd = narrow.length % 2 === 1 ? narrow[narrow.length - 1] : null;
  return items.map((item) => ({ ...item, wide: item.kind === "email" || item === lastOdd }));
}

const socialLinks = [
  {
    label: "Instagram",
    href: "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg==",
    kind: "instagram",
  },
  { label: "X", href: "https://x.com/AdlFront", kind: "x" },
  ...(siteBrand.youtube ? [{ label: "YouTube", href: "https://www.youtube.com/@thesy3d", kind: "youtube" }] : []),
  { label: "+91 99708 75040", href: "https://wa.me/919970875040", kind: "whatsapp" },
  { label: "+91 98004 15583", href: "https://wa.me/919800415583", kind: "whatsapp" },
  { label: "contact@adlfront.com", href: "mailto:contact@adlfront.com", kind: "email" },
];

/**
 * Explore column (plan §7.3 band 11): Home, Courses, Watch (same rule as the
 * header), Console, then the Al Syed pages (Hall of Fame, National Desk,
 * AS-Accounts, Join Al Syed) and the external Labs site.
 */
export function getFooterExploreLinks(brandId, watchState) {
  const alsyed = brandId !== "owlcognito";
  return [
    { label: "Home", to: "/" },
    { label: "Courses", to: "/courses" },
    watchState === "hidden" ? null : { label: "Watch", to: "/watch", disabled: watchState === "disabled" },
    { label: "Console", to: "/console" },
    alsyed ? { label: "Hall of Fame", to: "/hall-of-fame" } : null,
    alsyed ? { label: "National Desk", to: "/national-desk" } : null,
    alsyed ? { label: "AS-Accounts", to: "/as-accounts" } : null,
    alsyed ? { label: "Join Al Syed", to: "/join-alsyed" } : null,
    alsyed ? { label: "Labs", href: LABS_URL, external: true } : null,
  ].filter(Boolean);
}

function LaunchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="sf__icon-sm" fill="currentColor">
      <path d="M13 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h5v1H3v10h10V8h1v5a1 1 0 0 1-1 1z" />
      <path d="M10 1v1h3.3L9 6.3l.7.7L14 2.7V6h1V1z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="sf__icon-sm" fill="currentColor">
      <path d="M11.8 7.5 8.1 3.8l.7-.7L13.7 8l-4.9 4.9-.7-.7 3.7-3.7H2v-1z" />
    </svg>
  );
}

function FooterLink({ link }) {
  const reasonId = useId();
  if (link.disabled) {
    return (
      <span className="sf__link is-disabled" role="link" aria-disabled="true" tabIndex={0} aria-describedby={reasonId}>
        {link.label}
        <span id={reasonId} className="sf__reason">
          {WATCH_EMPTY_REASON}
        </span>
      </span>
    );
  }
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className="sf__link">
        {link.label}
        <LaunchIcon />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link to={link.to} className="sf__link">
      {link.label}
    </Link>
  );
}

function SocialIcon({ kind }) {
  if (kind === "instagram") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="sf__icon">
        <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="17" cy="7" r="1.1" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "x") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="sf__icon">
        <path d="M6 5l12 14M17.6 5L6.4 19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "youtube") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="sf__icon">
        <rect x="2.5" y="5" width="19" height="14" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 9.2v5.6l4.8-2.8L10 9.2Z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "whatsapp") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="sf__icon">
        <path d="M12 4.5a7.5 7.5 0 0 0-6.6 11.1L4.7 19l3.5-.6A7.5 7.5 0 1 0 12 4.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M9.7 9.2c-.2-.5-.5-.4-.7-.4h-.3c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2s.8 2.4.9 2.6c.1.2 1.5 2.4 3.7 3.2 1.8.7 2.2.6 2.5.5.4-.1 1.1-.5 1.2-1 .1-.4.1-.8.1-.9-.1-.1-.3-.2-.7-.4s-1.1-.5-1.3-.6c-.2-.1-.4-.1-.5.1-.2.2-.6.6-.7.8-.1.2-.3.2-.5.1-.2-.1-.9-.3-1.6-1-.6-.6-1-1.3-1.2-1.6-.1-.2 0-.3.1-.4l.3-.4.2-.3c.1-.1.1-.3 0-.4l-.7-1.7Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="sf__icon">
      <path d="M4 7h16v10H4z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.8 7.8l7.2 5.6 7.2-5.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function FooterSocialLink({ href, label, kind }) {
  const isMail = href.startsWith("mailto:");
  return (
    <a
      href={href}
      target={isMail ? undefined : "_blank"}
      rel={isMail ? undefined : "noopener noreferrer"}
      title={label}
      aria-label={label}
      className="sf__social"
    >
      <SocialIcon kind={kind} />
      <span className="sf__social-label">{label}</span>
    </a>
  );
}

/**
 * Website footer (Syed Carbon, plan §7.3 band 11): a g100 band with the brand,
 * Explore, Company and Support columns, the Connect row and the legal bar.
 * `id="contact"` is kept for anchors.
 */
export default function AppFooter() {
  const year = new Date().getFullYear();
  const { pathname } = useLocation();
  const youtube = useYouTubeChannel();
  const watchState = getWatchNavState({ brandHasYouTube: siteBrand.youtube, youtube });
  const exploreLinks = getFooterExploreLinks(siteBrand.id, watchState);
  // The landing page ends on a full-bleed band, so the footer follows it directly.
  const flush = pathname === "/";

  return (
    <footer id="contact" data-theme="g100" className={`sf${flush ? " sf--flush" : ""}`}>
      <div className="sf__inner">
        <div className="sf__grid">
          <section className="sf__brand" aria-label={siteBrand.name}>
            <BrandLogo variant="shell" />
            <p className="sf__description">{siteBrand.footerDescription}</p>
            <p className="sf__kicker">{siteBrand.footerKicker}</p>
          </section>

          {/* A short list (OwlCognito: 3 links) stays one column; never one link alone in a second column. */}
          <section className={`sf__col sf__col--explore${exploreLinks.length <= 4 ? " sf__col--short" : ""}`}>
            <h2 className="sf__heading">Explore</h2>
            <ul className="sf__list">
              {exploreLinks.map((link) => (
                <li key={link.label}>
                  <FooterLink link={link} />
                </li>
              ))}
            </ul>
          </section>

          <section className="sf__col">
            <h2 className="sf__heading">Company</h2>
            <ul className="sf__list">
              {companyLinks.map((link) => (
                <li key={link.label}>
                  <FooterLink link={link} />
                </li>
              ))}
            </ul>
          </section>

          <section className="sf__support">
            <h2 className="sf__heading">Need support?</h2>
            <p className="sf__support-text">Need help with enrollment, live classes, or account setup?</p>
            <div className="sf__support-actions">
              <Link to="/contact" className="sf__button sf__button--primary">
                Contact Support
                <ArrowIcon />
              </Link>
              <Link to="/about" className="sf__button sf__button--tertiary">
                Platform Overview
                <ArrowIcon />
              </Link>
            </div>
          </section>
        </div>

        <section className="sf__connect">
          <div className="sf__connect-copy">
            <h2 className="sf__heading">Connect</h2>
            <p className="sf__connect-text">Official channels for support and platform updates.</p>
          </div>
          <ul className="sf__socials" data-socials={socialLinks.filter((item) => !CONTACT_KINDS.has(item.kind)).length}>
            {markWideSocialLinks(socialLinks).map((item) => (
              <li
                key={`${item.kind}-${item.href}`}
                className={item.wide ? "sf__socials-wide" : undefined}
                data-group={CONTACT_KINDS.has(item.kind) ? "contact" : "social"}
              >
                <FooterSocialLink href={item.href} label={item.label} kind={item.kind} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="sf__legal">
        <div className="sf__legal-inner">
          <span>{"©"} {year} {siteBrand.name}. All rights reserved.</span>
          <span>Secure Learning Infrastructure</span>
        </div>
      </div>
    </footer>
  );
}

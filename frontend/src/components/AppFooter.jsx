import "./AppFooter.css";

import { useId } from "react";
import { Link } from "react-router-dom";
import { CHANGELOG_PATH, CURRENT_VERSION } from "../config/releaseNotes";
import { siteBrand } from "../config/siteBrand";
import { useYouTubeChannel } from "../features/youtube/youTubeStore";
import Wordmark from "../marketing/Wordmark";
import BrandLogo from "./BrandLogo";
import { getWatchNavState, LABS_URL, WATCH_EMPTY_REASON } from "./siteNavModel";

const companyLinks = [
  { label: "About Us", to: "/about" },
  { label: "Contact", to: "/contact" },
  { label: "FAQs", to: "/faqs" },
  { label: "Terms", to: "/terms" },
];

// Phone numbers and the email address need a full row on small phones (never "+91 99708 750…").
const CONTACT_KINDS = new Set(["whatsapp", "email"]);

/**
 * Phones lay the channel pills out two per row; the email address and an odd
 * last channel take a full row so nothing is cut off and no cell stays empty.
 */
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
 * Explore column: Home, Courses, Watch (same rule as the header), Console,
 * then the Al Syed pages (Hall of Fame, National Desk, AS-Accounts, Join Al
 * Syed) and the external Labs site.
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

/** Learn column (Al Syed): the tracks, the roadmap and pricing. */
export function getFooterLearnLinks(brandId) {
  if (brandId === "owlcognito") return [];
  return [
    { label: "OSINT track", to: "/tracks/osint" },
    { label: "Pentesting (coming soon)", to: "/tracks/pentesting" },
    { label: "Roadmap", to: "/roadmap" },
    { label: "Pricing", to: "/pricing" },
  ];
}

function LaunchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="sf__icon-sm" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 11 11 5M6 5h5v5" />
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
        <path d="M9.4 9.4c.3 2.3 2 4.4 4.6 5.1l.9-1.2-1.5-.8-.6.6c-.9-.4-1.6-1.1-2-2l.6-.6-.8-1.5z" fill="currentColor" />
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

/** A footer call to action: 24 px text + a circle with ↗ that nudges on hover (M7). */
function FooterCta({ to, title, sub, solid = false }) {
  return (
    <Link to={to} className={`sf__cta${solid ? " sf__cta--solid" : ""}`}>
      <span className="sf__cta-text">
        <span className="sf__cta-title">{title}</span>
        <span className="sf__cta-sub">{sub}</span>
      </span>
      <span className="sf__cta-circle" aria-hidden="true">
        <LaunchIcon />
      </span>
    </Link>
  );
}

/**
 * Website footer (HackPath philosophy, T7): statement, link columns, channel
 * pills and two calls to action, the legal row, then the giant brand
 * wordmark cropped by the page end. `id="contact"` is kept for anchors.
 */
export default function AppFooter() {
  const year = new Date().getFullYear();
  const youtube = useYouTubeChannel();
  const watchState = getWatchNavState({ brandHasYouTube: siteBrand.youtube, youtube });
  const exploreLinks = getFooterExploreLinks(siteBrand.id, watchState);
  const learnLinks = getFooterLearnLinks(siteBrand.id);

  return (
    <footer id="contact" data-theme="g100" className="sf">
      <div className="sf__inner">
        <div className="sf__grid">
          <section className="sf__brand" aria-label={siteBrand.name}>
            <BrandLogo variant="shell" />
            <p className="sf__statement">{siteBrand.footerDescription}</p>
            <p className="sf__kicker">{siteBrand.footerKicker}</p>
          </section>

          <div className="sf__cols">
            <section className="sf__col">
              <h2 className="sf__heading">Explore</h2>
              <ul className="sf__list">
                {exploreLinks.map((link) => (
                  <li key={link.label}>
                    <FooterLink link={link} />
                  </li>
                ))}
              </ul>
            </section>

            {learnLinks.length ? (
              <section className="sf__col">
                <h2 className="sf__heading">Learn</h2>
                <ul className="sf__list">
                  {learnLinks.map((link) => (
                    <li key={link.label}>
                      <FooterLink link={link} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

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
          </div>

          <section className="sf__support" aria-label="Get started">
            <FooterCta to="/courses" title="Browse courses" sub="OSINT now, Pentesting soon" solid />
            <FooterCta to="/contact" title="Talk to the team" sub="Enrolment, classes and accounts" />
          </section>
        </div>

        <section className="sf__connect">
          <h2 className="sf__heading">Connect</h2>
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

        <div className="sf__legal">
          <span>
            {"©"} {year} {siteBrand.name}. All rights reserved.
          </span>
          <span className="sf__legal-end">
            <span>Secure Learning Infrastructure</span>
            <Link to={CHANGELOG_PATH} className="sf__version" aria-label={`Version ${CURRENT_VERSION}: what's new`}>
              {CURRENT_VERSION}
            </Link>
          </span>
        </div>
      </div>

      <div className="sf__mark">
        <Wordmark />
      </div>
    </footer>
  );
}

// Per-route <title>, description, canonical and robots for the public website.
// The SPA serves one index.html, so these are applied on navigation (search
// engines render JavaScript; link previews use the defaults in index.html).
import { matchPath } from "react-router-dom";

import { siteBrand } from "./siteBrand";

const brandOnly = (route) => !route.brandOnly || route.brandOnly === siteBrand.id;

const ROUTES = [
  { path: "/", title: "", description: siteBrand.description },
  {
    path: "/courses",
    title: "Courses",
    description: "Every OSINT course, the four investigation labs, free practice and the five Pentesting tiers (coming soon), with module outlines open to read.",
  },
  { path: "/courses/:id", title: "Course details", description: "Curriculum, schedule, fees, reviews and enrollment for this training program." },
  { path: "/courses/:id/register", title: "Course registration", noindex: true },
  { path: "/courses/:id/payment", title: "Course payment", noindex: true },
  {
    path: "/watch",
    title: "Watch",
    description: "Free live classes, investigations and talks from the Al Syed YouTube channel, with the latest videos in one place.",
    when: () => siteBrand.youtube,
  },
  { path: "/about", title: "About us", description: siteBrand.id === "alsyed" ? "Founded by cyber activist Al Syed under the ADL Front: lawful, evidence-first OSINT training to counter misinformation." : `Who we are, what we teach and how ${siteBrand.name} trains practical, ethical investigation skills.` },
  { path: "/contact", title: "Contact", description: "Reach the team on WhatsApp, e-mail or social media, or send a message from the contact form." },
  { path: "/faqs", title: "FAQs", description: "Access, payments, recordings, certificates and refunds, answered before you enrol." },
  { path: "/terms", title: "Terms and conditions", description: `The terms and conditions for using ${siteBrand.name}.` },
  {
    path: "/pricing",
    title: "Pricing",
    description: "Start free on curated OSINT challenges and the monthly CTF, then choose Starter or the CTF Labs membership for every lab and new cases monthly.",
  },
  {
    path: "/changelog",
    title: "What's new",
    description: "Release notes for every version of the website, the Console, the labs and the exams, starting with v4.0-Thrallback.",
  },
  { path: "/roadmap", title: "Roadmap", description: "What you can start today in OSINT, what opens next in Pentesting, and the order we recommend." },
  {
    path: "/tracks/osint",
    title: "OSINT track",
    description: "Turn usernames, photos and domains into evidence that holds up: live classes Fri to Sun, weekly marked reports, real labs, an exam and a verifiable certificate.",
  },
  {
    path: "/tracks/pentesting",
    title: "Pentesting track",
    description: "Coming soon: five tiers from security thinking to Active Directory attacks. Browse every course and module outline now; enrolment opens at launch.",
  },
  { path: "/bootcamp", title: "Foundations bootcamp", description: "The Pentesting Foundations bootcamp: four courses as four phases. Coming soon." },
  {
    path: "/osint/free",
    title: "Free OSINT challenges",
    description: "A curated path through free OSINT challenges on other platforms, the monthly live CTF and progress you track yourself.",
  },
  { path: "/login", title: "Sign in", description: `Sign in to your ${siteBrand.name} account to open your courses and live classes.` },
  { path: "/reset-password", title: "Choose a new password", noindex: true },
  {
    path: "/as-accounts",
    title: "Verified accounts",
    description: "The official, verified Al Syed social media accounts: check a handle before you trust it.",
    brandOnly: "alsyed",
  },
  {
    path: "/national-desk",
    title: "National Desk",
    description: "How to file an FIR, the laws to know and FIR filing across India: practical legal guidance in one place.",
    brandOnly: "alsyed",
  },
  {
    path: "/join-alsyed",
    title: "Join Al Syed",
    description: "Join the Al Syed network as a citizen volunteer or a lawyer and support legal and civic response work.",
    brandOnly: "alsyed",
  },
  {
    path: "/hall-of-fame",
    title: "Hall of Fame",
    description: "The Al Syed Initiative Hall of Fame: every investigator who passed the certification exam, by batch, each with a certificate anyone can verify.",
    brandOnly: "alsyed",
  },
  // Monthly OSINT CTF (WS-MONTHLY-CTF).
  {
    path: "/monthly-ctf",
    title: "Monthly OSINT CTF",
    description: "One free OSINT case every month for every registered student, with a live leaderboard, the Golden Aura and trophies.",
  },
  {
    path: "/monthly-ctf/hall-of-fame",
    title: "Monthly CTF Hall of Fame",
    description: "The champions and top ten finalists of every Monthly OSINT CTF season.",
  },
  { path: "/monthly-ctf/certificates/:slug", title: "Finalist certificate", description: "Verify a Monthly OSINT CTF finalist certificate.", noindex: true },
  // Verifiable certificates (WS-CERTIFICATES); the certificate page then sets its own title and preview image.
  { path: "/certificates", title: "Verify a certificate", description: "Check a certificate by its reference number.", noindex: true },
  { path: "/certificates/:reference", title: "Certificate", description: "A certificate issued by the Al Syed Initiative.", noindex: true },
];

const NOT_FOUND = { title: "Page not found", description: "", noindex: true, notFound: true };

/** The meta for a website path; unknown paths are "not found" (noindex). */
export function resolvePageMeta(pathname = "/") {
  const path = String(pathname || "/").split(/[?#]/)[0] || "/";
  const route = ROUTES.filter(brandOnly)
    .filter((item) => !item.when || item.when())
    .find((item) => matchPath({ path: item.path, end: true }, path));
  const meta = route || NOT_FOUND;
  return {
    title: meta.title ? `${meta.title} | ${siteBrand.name}` : siteBrand.documentTitle,
    description: meta.description || siteBrand.description,
    noindex: Boolean(meta.noindex),
    notFound: Boolean(meta.notFound),
    canonicalPath: meta.notFound ? null : path.replace(/\/+$/, "") || "/",
  };
}

function siteOrigin() {
  const configured = String(import.meta.env.VITE_SITE_ORIGIN || siteBrand.siteOrigin || "").replace(/\/+$/, "");
  if (configured) return configured;
  return typeof window === "undefined" ? "" : window.location.origin;
}

function upsertMeta(attr, key, content) {
  let element = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (content == null) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attr, key);
    document.head.appendChild(element);
  }
  element.setAttribute("content", content);
}

function upsertCanonical(href) {
  let element = document.head.querySelector('link[rel="canonical"]');
  if (!href) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement("link");
    element.setAttribute("rel", "canonical");
    document.head.appendChild(element);
  }
  element.setAttribute("href", href);
}

/** Writes the meta for `pathname` into <head>. */
export function applyPageMeta(pathname) {
  if (typeof document === "undefined") return null;
  const meta = resolvePageMeta(pathname);
  const canonical = meta.canonicalPath ? `${siteOrigin()}${meta.canonicalPath === "/" ? "/" : meta.canonicalPath}` : null;
  document.title = meta.title;
  upsertMeta("name", "description", meta.description);
  upsertMeta("name", "robots", meta.noindex ? "noindex, follow" : null);
  upsertMeta("property", "og:title", meta.title);
  upsertMeta("property", "og:description", meta.description);
  upsertMeta("property", "og:url", canonical);
  upsertMeta("name", "twitter:title", meta.title);
  upsertMeta("name", "twitter:description", meta.description);
  upsertCanonical(canonical);
  return meta;
}

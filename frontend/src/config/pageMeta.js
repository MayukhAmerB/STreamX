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
    description: "Browse OSINT and web application penetration testing courses, upcoming batches and live classes open for registration.",
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
  { path: "/about", title: "About us", description: `Who we are, what we teach and how ${siteBrand.name} trains practical, ethical cybersecurity skills.` },
  { path: "/contact", title: "Contact", description: "Reach the team on WhatsApp, e-mail or social media, or send a message from the contact form." },
  { path: "/faqs", title: "FAQs", description: "Answers about courses, payments, access, certificates, refunds and support before you enroll." },
  { path: "/terms", title: "Terms and conditions", description: `The terms and conditions for using ${siteBrand.name}.` },
  { path: "/login", title: "Sign in", description: `Sign in to your ${siteBrand.name} account to open your courses and live classes.` },
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
    description: "Students who met the Al Syed certification standard through skill, discipline and investigation.",
    brandOnly: "alsyed",
  },
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

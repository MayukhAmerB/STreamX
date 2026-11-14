// Marketing copy for the public pages (pricing band, /pricing, /courses,
// /tracks/*, /roadmap, /about, /faqs, /watch). The components only lay these
// strings out; links, routes and data sources live in the components.
// Landing-page copy is in pages/landing/landingContent.js.
//
// Voice: confident, specific, lawful. Every claim must be checkable on the
// site (schedule, lab names, certificate format). Owner review list and the
// three options per section: scratchpad copy/OPTIONS.md.
// `accent` is the one handwritten (Handlee) word of a headline.
import { brandText } from "../config/siteBrand";

export const PRICING_BAND = {
  // "Practise free. Members go deeper." (accent: deeper)
  before: "Practise free. Members go",
  accent: "deeper",
  after: ".",
  lead: "No card for Free: our challenge path and the monthly CTF. Starter adds the easy and medium labs. The CTF Labs membership opens every lab, new cases each month and this month's recorded classes.",
  trustLabel: "Payment facts",
  compareCta: "Compare every plan",
};

export const PRICING_PAGE = {
  tagline: "Start where you are",
  // "Start free. Pay for the cases." (accent: cases)
  line1: "Start free.",
  line2Before: "Pay for the",
  accent: "cases",
  lead: "Practise on free public challenges first. Pay only when you want our labs, new cases every month and recorded classes. No card for the Free plan.",
  pentesting: {
    eyebrow: "Coming soon",
    before: "Pentesting",
    accent: "plans",
    lead: "Browse every Pentesting course now. These plans open at launch; prices appear once they are confirmed.",
    link: "Browse the Pentesting tiers →",
  },
  faq: { kicker: "FAQ", before: "Questions about", accent: "plans" },
};

export const CATALOGUE = {
  tagline: "Start where you are",
  // "Read every outline before you pay." (accent: pay)
  line1: "Read every outline",
  line2Before: "before you",
  accent: "pay",
  lead: "The current OSINT batch, four investigation labs, free practice and all five Pentesting tiers, with every module outline open to anyone.",
  primaryCta: "Start free",
  secondaryCta: "See pricing",
  pentestingNotice: { eyebrow: "Coming soon", title: "Pentesting is coming soon", body: "Browse every course and module now; enrolment opens at launch." },
  freeSection: {
    kicker: "Free tier",
    title: "Free",
    summary: "Free OSINT challenges with our path through them, and the monthly live CTF. The labs are open to everyone until memberships launch.",
  },
  osintSection: {
    kicker: "Open now",
    title: "Open Source Intelligence",
    summary: "Taught live Fri, Sat and Sun, recorded for you, reported weekly and examined at the end.",
  },
};

export const OSINT_TRACK = {
  tagline: "Everything leaves a trace",
  lead: "A username, a photo, a domain: learn to turn each one into evidence that holds up, lawfully. Start free, then join the live batch or the labs.",
  cohortCta: "Join the live cohort",
  coursesCta: "See OSINT courses",
  freeCta: "Start free",
  examStat: "Timed",
  freeEyebrow: "Free tier",
  freeTitle: "Free challenges, with our map through them",
  labsTitle: "The labs",
  labsMembers: "Our own cases on labs.alsyedinitiative.com: easy and medium in Starter, everything in the CTF Labs membership.",
  labsOpen: "Our own cases on labs.alsyedinitiative.com. Open to everyone until memberships launch.",
  cohortsTitle: "Live cohorts",
  cohortsSummary: "Taught live Fri, Sat and Sun, recorded for you, reported weekly and examined at the end.",
  faq: { kicker: "FAQ", before: "Before you", accent: "start" },
};

export const PENTESTING_TRACK = {
  tagline: "Break it before someone else does",
  lead: "Five tiers, from security thinking to Active Directory attacks. Every course and module outline is open now; enrolment opens at launch.",
  soonNote: "Coming soon: browse everything, enrol at launch.",
  plansCta: "See Pentesting plans",
  tiersCta: "Browse the tiers",
  notice: { eyebrow: "Coming soon", title: "Pentesting opens soon", body: "Browse every course and module now; enrolment opens at launch." },
  faq: { kicker: "FAQ", before: "Before it", accent: "opens" },
};

export const ROADMAP = {
  eyebrow: "Learning roadmap",
  title: "Open today. Opening next.",
  lead: "OSINT is live now. Pentesting's five tiers are mapped and open to browse. Here is what you can start today and the order we recommend.",
};

export const ABOUT = {
  tagline: brandText("Founded by cyber activist Al Syed", "Who we are"),
  // Al Syed: "Silence one voice. Thousands rise." (accent: rise), from the founding story.
  line1: brandText("Silence one voice.", "About"),
  line2Before: brandText("Thousands", ""),
  accent: brandText("rise", "us"),
  lead: brandText(
    "Al syed Initiative is the cybersecurity education and awareness project of the ADL Front (Advanced Digital Lawforce Front). We train people to investigate responsibly, think critically and stand against misinformation, using public sources and lawful methods.",
    "OwlCognito helps learners build practical investigation skills with structured, live and evidence-first training.",
  ),
  missionEyebrow: "Our mission",
  missionTitle: "Evidence beats outrage.",
  missionBody: [
    brandText(
      "Al Syed believes knowledge, discipline and digital awareness are the strongest tools of the information age, and that if one voice is silenced, thousands more should be ready to rise. The Initiative carries that work forward.",
      "We design lessons for learners who want a clear path from fundamentals to professional execution.",
    ),
    "We teach a repeatable method (question, collect, verify, report) through live classes, marked reports, real lab cases and an examination, so learners can challenge misinformation with evidence rather than opinion.",
  ],
  pillars: [
    { lead: "Method before tools.", text: "Workflows you can apply in real investigations, not tool demos." },
    { lead: "Evidence or it didn't happen.", text: "Every finding sourced, archived and reproducible." },
    { lead: "Public sources. Lawful use.", text: "We investigate to protect people, never to harm them." },
  ],
  teachLines: ["Method first", "Tools after"],
  teach: [
    { title: "OSINT research and target profiling", sub: "Search, verify and archive what is public, then profile with care." },
    { title: "Reconnaissance and attack surface mapping", sub: "See an organisation the way an attacker would, within scope." },
    { title: "Web application testing workflows", sub: "Find, prove and report weaknesses with a structured method (Pentesting track, coming soon)." },
    { title: "Evidence-driven reporting", sub: "Every finding sourced, reproducible and written for the reader." },
  ],
  // Closing CTA: "Your first case is free" (accent: free)
  ctaBefore: "Your first case is",
  ctaAccent: "free",
  ctaLead: "Practise free today, join the live OSINT batch, or read the Pentesting outlines before they open.",
  ctaPrimary: "Browse courses",
  ctaSecondary: "Talk to the team",
};

export const FAQ_PAGE = {
  tagline: "Ask before you enrol",
  // "No small print" (accent: print)
  before: "No small",
  accent: "print",
  lead: "Access, payments, recordings, certificates and refunds, answered before you pay.",
};

export const WATCH_PAGE = {
  // Shown only when the server (admin → Site media) sends no subtitle.
  fallbackSubtitle: "Free live OSINT classes and investigations from the Al Syed YouTube channel. Watch one before you enrol.",
};

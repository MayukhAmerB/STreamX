// Landing page copy shared by the current page (v2) and the rollback page
// (v1, VITE_LANDING_V2=off). Strings are kept verbatim (plan §7.3).
import { brandText, siteBrand } from "../../config/siteBrand";

export const HERO_EYEBROW = "Professional cybersecurity training";
export const HERO_SUMMARY =
  "Learn OSINT, reconnaissance, and web application testing through structured live programs, protected recordings, and practical instructor guidance.";
export const TRUST_ITEMS = ["Live mentorship", "Protected recordings", "Verified certificates"];

// Key figures are live (GET /api/site/stats/, marketing/siteStats.js): counted
// from real records, hidden while small. No typed-in numbers here.

export const INFO_CARDS = [
  {
    title: "About Us",
    body: brandText(
      "Al syed Initiative is a cybersecurity learning platform focused on practical skills, ethical testing, and professional workflows.",
      "OwlCognito is a private intelligence learning platform focused on practical research, ethical investigation, and professional workflows.",
    ),
  },
  {
    title: "Courses We Provide",
    body: "OSINT, reconnaissance, attack surface mapping, and web application penetration testing training with structured methodology.",
  },
  {
    title: "Our Message",
    body: "Learn cybersecurity with clarity and discipline. Build a repeatable process, not just a list of tools.",
  },
];

export const WHY_CHOOSE = [
  {
    icon: "flow",
    title: "Flexible learning structure",
    body: "A clear module flow and practical checkpoints that fit self-paced or guided learning.",
  },
  {
    icon: "target",
    title: "Professional instruction style",
    body: "Methodology-first teaching that connects recon findings to real testing decisions.",
  },
  {
    icon: "stack",
    title: "Measured progress",
    body: "Track growth with structured modules, lessons, and hands-on workflow-based learning.",
  },
];

export const JOURNEY_STEPS = [
  {
    no: "1",
    title: "Enroll in the flagship course",
    body: "Start with OSINT for Cyber security and Web Application Penetration Testing.",
  },
  {
    no: "2",
    title: "Learn the recon workflow",
    body: "Understand target profiling, attack surface mapping, and OSINT prioritization.",
  },
  {
    no: "3",
    title: "Apply web app pentesting",
    body: "Use structured methodology to test, validate, and document findings.",
  },
];

export const WHY_TITLE = `Why learners choose ${siteBrand.name}`;
export const WHY_SUBTITLE =
  "Cybersecurity training depth with a modern online learning experience focused on professional execution.";
export const JOURNEY_TITLE = "How your journey works";
export const JOURNEY_SUBTITLE =
  "A simple onboarding path into structured cybersecurity learning and hands-on practice.";
export const ABOUT_TITLE = "Built for disciplined learning";
export const ABOUT_SUBTITLE =
  "A focused cybersecurity education platform for students who value method, evidence, and responsible practice.";
export const LIVE_CLASSES_TITLE = "Live every Fri, Sat and Sun";
export const LIVE_CLASSES_SUBTITLE =
  "7 to 8 PM IST. Ask the instructor while it's live, then rewatch the recording, watermarked to your account.";
export const BESTSELLERS_EMPTY =
  "Live courses are being updated. Submit an enrollment enquiry and our team will contact you.";
export const CTA_TITLE = "Ready to start your cybersecurity journey?";
export const CTA_BODY =
  "Join our flagship course and learn OSINT plus web application pentesting with a structured workflow.";

/* ------------------------------------------------------------------------
 * Landing page (HackPath-philosophy page, LandingPageHP.jsx). Every marketing
 * string on "/" lives here; the components only lay it out. Voice and the
 * claim sources: scratchpad copy/VOICE.md + OPTIONS.md (owner review list).
 * `accent` is the one handwritten (Handlee) word of a headline.
 * ---------------------------------------------------------------------- */

export const HP_HERO = {
  headline: ["Trace it.", "Verify it.", "Prove it."],
  sub: "Live OSINT investigation training. Start from a photo, a username or a domain, pivot through public sources and finish with evidence that holds up, marked by an instructor every week.",
  badgeLive: "Live",
  badgeSchedule: "Fri · Sat · Sun 7 PM IST",
  primaryCta: "Start free",
  secondaryCta: "Browse courses",
  liveLabel: "Class is live",
  liveFallback: "Join your live classroom",
  liveCta: "Join now",
  statsLabel: "Al Syed Initiative in numbers",
};

/** The two course categories in the hero (OSINT live; Pentesting browsable, coming soon). */
export const HP_HERO_TRACKS = {
  label: "Course categories",
  osint: {
    kind: "Category 01",
    title: "OSINT",
    status: "Live now",
    description: "Turn a photo, a username or a domain into evidence that holds up.",
    fact: "Live Fri · Sat · Sun, 7 PM IST",
  },
  pentesting: {
    kind: "Category 02",
    title: "Pentesting",
    status: "Coming soon",
    statusOpen: "Enrolment open",
    description: "Five tiers, from security thinking to Active Directory attacks.",
    fact: "Browse every outline now",
  },
};

/** The hero's terminal panel: one illustrative case, pivot by pivot (public sources only). */
export const HP_HERO_TRACE = {
  title: "case-0419 · osint pivot chain",
  command: "trace --from photo_0419.jpg",
  steps: [
    { tag: "photo", detail: "Shadow falls at 212°: late afternoon, facing south-west" },
    { tag: "metadata", detail: "EXIF stripped; embedded thumbnail keeps the capture date" },
    { tag: "street view", detail: "Shop sign and kerb paint matched to one junction" },
    { tag: "username", detail: "Same handle reused on 3 public platforms" },
    { tag: "crt.sh", detail: "Certificate-transparency log names the owner's domain" },
  ],
  closed: "Case closed: 5 pivots, public sources only",
  caption: "An example investigation: from a single photo to a closed case in five pivots.",
};

export const HP_TRACKS = {
  heading: "Professional tracks",
  osint: {
    title: "Open Source Intelligence",
    eyebrow: "Live classes · labs · exam",
    description: "A username, a photo, a domain: turn each one into evidence that holds up, using public sources only.",
    facts: "Live Fri, Sat, Sun · 7 PM IST",
    action: "Explore the track",
  },
  pentesting: {
    title: "Pentesting",
    eyebrow: "Five tiers · self-paced and live",
    description: "Five tiers, from security thinking to Active Directory attacks. Read every outline now; enrolment opens at launch.",
    factsOpen: "Enrolment open",
    factsSoon: "Browse now, enrol at launch",
    action: "Browse the tiers",
  },
};

export const HP_OPEN_NOW = {
  eyebrow: "Current batches",
  // "Enrolling now" (accent: now)
  lead: "Enrolling",
  accent: "now",
  body: "The OSINT batch taking students now and the classes running this month. Each card shows the schedule, the format and reviews from enrolled students.",
  cta: "All courses",
};

export const HP_STORY = {
  lines: ["Learn it live", "Prove it on record"],
  lead: "Not a pile of videos: a weekly rhythm of live classes, a marked report and lab cases, ending in an exam and a certificate with its own reference number.",
  asideEyebrow: "How we teach",
  asideTitle: "Method before tools.",
  asideBody: "We teach the habits that make an investigation hold up: question, collect, verify, report.",
  steps: [
    { kicker: "Choose", title: "Pick your track", sub: "OSINT is open now. Pentesting's five tiers are open to browse before launch." },
    { kicker: "Learn", title: "Ask live. Rewatch later.", sub: "Fri, Sat and Sun at 7 PM IST. Every broadcast class is recorded and watermarked to your account." },
    { kicker: "Write", title: "Write it like evidence", sub: "A weekly report, marked by an instructor. If you can't defend it, it isn't finished." },
    { kicker: "Practise", title: "Work cases, not quizzes", sub: "The Zenith Footprint, the Real-World lab and Black Meridian: exact-answer flags, from easy to professional." },
    { kicker: "Prove", title: "Sit the exam", sub: "Timed, graded and recorded against your account. No hints, no walkthroughs." },
    { kicker: "Show", title: "Earn a certificate anyone can verify", sub: "Each one carries a reference like ASI-2026-OSINT-000042-7 that anyone can check online. Plus your member ID card." },
  ],
  principles: [
    { lead: "Method before tools.", text: "Tools change every year; a sound investigative method does not." },
    { lead: "Evidence or it didn't happen.", text: "Every claim is sourced, archived and reproducible." },
    { lead: "Small weekly steps.", text: "A class, a report and a lab each week beat a weekend cram." },
    { lead: "Real feedback.", text: "Instructors mark your reports and answer your lecture questions." },
    { lead: "Public sources. Lawful use.", text: "We investigate to protect people and expose misinformation, never to harm them." },
  ],
};

export const HP_PRACTISE = {
  lines: ["Read the brief", "Work the case"],
  lead: "Every module ends at a keyboard. Start on free public challenges today, then go deeper in our own labs: The Zenith Footprint, the Real-World OSINT lab, Black Meridian and the ten-question Certification CTF.",
  terminalTitle: "free challenge · geolocation",
  terminal: [
    { kind: "prompt", text: "$ start --challenge street-corner" },
    { kind: "out", text: "One photo. Find the city, then the corner." },
    { kind: "prompt", text: "$ note shadows=west signage=bilingual" },
    { kind: "out", text: "Narrowed to 3 districts · checking street view" },
    { kind: "hit", text: "Solved. Marked done on your path." },
  ],
  columns: {
    free: {
      title: "Free path + monthly CTF",
      body: "Our path through free public challenges, plus one free CTF case on the 1st of every month. The fastest clean solve wears the Golden Aura.",
      cta: "Start free",
    },
    labs: {
      title: "Members' labs",
      body: "Expert cases with no investigation path: map identities, infrastructure and DNS residue on your own. New cases every month.",
      cta: "See membership",
    },
    roadmap: {
      title: "A map of what comes next",
      body: "What is open today, what opens next and the order we recommend.",
      cta: "Explore the roadmap",
    },
  },
};

export const HP_COMMUNITY = {
  eyebrowPrefix: "About",
  // "Never investigate alone" (accent: alone)
  lead: "Never investigate",
  accent: "alone",
  body: brandText(
    "Founded by cyber activist Al Syed under the ADL Front to build people who verify before they share. Instructors answer questions live, your reports get marked, and your batch works the same cases.",
    "Instructors answer questions live, your reports get marked, and your batch works the same cases as you.",
  ),
  aboutCta: "About us",
  hallCta: "Hall of Fame",
  statsLabel: "About us in numbers",
};

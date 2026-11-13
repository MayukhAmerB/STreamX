// Landing page copy shared by the current page (v2) and the rollback page
// (v1, VITE_LANDING_V2=off). Strings are kept verbatim (plan §7.3).
import { brandText, siteBrand } from "../../config/siteBrand";

export const HERO_EYEBROW = "Professional cybersecurity training";
export const HERO_SUMMARY =
  "Learn OSINT, reconnaissance, and web application testing through structured live programs, protected recordings, and practical instructor guidance.";
export const TRUST_ITEMS = ["Live mentorship", "Protected recordings", "Verified certificates"];

/** Owner-confirmed figures (decision D1): shown as-is until an API feeds them. */
export const LANDING_STATS = [
  { value: "1000+", label: "Students trained" },
  { value: "98%", label: "Learner satisfaction" },
  { value: "6x", label: "Practical labs per module" },
  { value: "1:1", label: "Mentor support" },
];

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
export const LIVE_CLASSES_TITLE = "Live classes";
export const LIVE_CLASSES_SUBTITLE =
  "Current live OSINT classes: three sessions a week, each included with its professional training program.";
export const BESTSELLERS_EMPTY =
  "Live courses are being updated. Submit an enrollment enquiry and our team will contact you.";
export const CTA_TITLE = "Ready to start your cybersecurity journey?";
export const CTA_BODY =
  "Join our flagship course and learn OSINT plus web application pentesting with a structured workflow.";

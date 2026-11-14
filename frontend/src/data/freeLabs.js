// The OSINT labs on labs.alsyedinitiative.com (OSINTCTF tabs 01-04) and how
// the marketing pages describe them. File name kept from the build plan.
//
// Owner decision (OSINT membership rules): the four labs are members-only once
// the `labs_membership_required` switch is on (the labs server enforces it).
// Until then they stay exactly as open as today, so the cards say "Open now".
// Tab 05 (the proctored Examination) is never presented as free or open: it is
// for enrolled students and is part of the membership's certification exam.
import { LABS_URL } from "../components/siteNavModel";

export { LABS_URL };

/** Deep link to one tab of the labs site (the labs app selects the tab from the hash). */
export function labUrl(tab) {
  return tab ? `${LABS_URL}/#${tab}` : LABS_URL;
}

export const LABS = Object.freeze([
  {
    id: "hub",
    index: "01",
    tab: "hub",
    title: "CTF hub",
    case: "The Zenith Footprint",
    summary: "Start here: the brief, the scoring rules and the easy and medium challenges of the hub.",
    difficulty: "Easy to medium",
    levels: ["easy", "medium"],
    challenges: null,
    art: "flag",
    plan: "starter",
  },
  {
    id: "realworld",
    index: "02",
    tab: "realworld",
    title: "Real-World OSINT lab",
    case: "Active investigation",
    summary: "One handle, no investigation path: map identities, infrastructure and protected artifacts on your own.",
    difficulty: "Expert",
    levels: ["expert"],
    challenges: 10,
    art: "magnifier",
    plan: "membership",
  },
  {
    id: "blackmeridian",
    index: "03",
    tab: "blackmeridian",
    title: "Black Meridian",
    case: "Elite correlation",
    summary: "Pivot across repositories, commit history, metadata and DNS residue to recover a protected payload.",
    difficulty: "Expert",
    levels: ["expert"],
    challenges: 10,
    art: "compass",
    plan: "membership",
  },
  {
    id: "certification",
    index: "04",
    tab: "certification",
    title: "Certification CTF",
    case: "Exact-answer validation",
    summary: "Ten questions, no hints and no walkthroughs: prove the method end to end.",
    difficulty: "Professional",
    levels: ["professional"],
    challenges: 10,
    art: "certificate",
    plan: "membership",
  },
]);

/** The proctored exam (tab 05): enrolled students only, never free. */
export const EXAM_LAB = Object.freeze({
  id: "exam",
  index: "05",
  tab: "exam",
  title: "OSINT Examination",
  summary: "A timed, graded examination recorded against your account. For enrolled students and members.",
  art: "certificate",
});

/**
 * How a lab card reads right now. `membershipRequired` mirrors the server's
 * `labs_membership_required` switch (catalog gates); it never changes access,
 * only the words, because the labs server is the one that enforces it.
 */
export function labAccess(lab, { membershipRequired = false } = {}) {
  if (!membershipRequired) {
    return { kind: "open", label: "Open now", note: "Open to everyone until memberships launch." };
  }
  if (lab?.plan === "starter") {
    return { kind: "members", label: "Starter + members", note: "Easy and medium challenges are in Starter; everything is in the CTF Labs membership." };
  }
  return { kind: "members", label: "Members", note: "Included in the CTF Labs membership." };
}

/** Free tier (owner rules): a curated directory of free, server-less OSINT challenges + the monthly CTF. */
export const FREE_TIER = Object.freeze({
  title: "Free",
  summary: "A curated directory of free OSINT challenges on other platforms, our learning path through them, and the monthly live CTF.",
  href: "/osint/free",
});

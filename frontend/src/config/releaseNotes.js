// Release notes for the public /changelog page and the version pill (site
// footer, Console sidebar). To ship a new version, add an entry at the TOP of
// RELEASES; CURRENT_RELEASE (and every pill) follows automatically.

export const RELEASES = Object.freeze([
  {
    version: "v4.0-Thrallback",
    date: "2026-11-15",
    summary: "A new look, rewards for steady work, verifiable certificates and one sign-in for classes, labs and exams.",
    groups: [
      {
        title: "New look",
        items: [
          "A new home page hero with an investigation console.",
          "OSINT and Pentesting category tiles.",
          "Real student stats on the home page.",
        ],
      },
      {
        title: "Rewards",
        items: [
          "XP and 8 ranks, from Recruit to Elite Operator.",
          "Badges.",
          "A weekly leaderboard with prizes.",
          "Achievements and levels pages.",
        ],
      },
      {
        title: "Certificates",
        items: [
          "Verifiable certificates with a reference number and a QR code.",
          "A public certificate verification page.",
          "Automatic certification after the exam once you reach the pass mark.",
          "The Hall of Fame is back, with every previous graduate.",
        ],
      },
      {
        title: "Classes",
        items: ["Attendance: 40 minutes or more in a live class counts as present.", "A class calendar."],
      },
      {
        title: "Labs & exams",
        items: [
          "Single sign-in from your Al Syed account into the labs.",
          "The proctored examination system, with timed papers and per-question attempts.",
          "The monthly OSINT CTF.",
        ],
      },
      {
        title: "Profiles",
        items: ["Customizable public profiles, with privacy protection (only handles are shown)."],
      },
      {
        title: "Fixes",
        items: ["Password reset links work again.", "Achievements and leaderboard pages fixed.", "Mobile layout fixes."],
      },
    ],
  },
]);

export const CURRENT_RELEASE = RELEASES[0];
export const CURRENT_VERSION = CURRENT_RELEASE.version;
export const CHANGELOG_PATH = "/changelog";

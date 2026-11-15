// Reward-system copy for the public site (the Friday landing band and
// /rewards). Ported from the 13ca6b79 landing "Rewards" section
// (pages/landing/landingContent.js HP_REWARDS) and the backend rules:
// XP economy v2 (apps/engagement/rules.py), the badge catalogue
// (apps/engagement/badges.py) and the Monthly CTF rewards (apps/ctf).
// Ranks come from engagementModel.LEVELS (the same thresholds the API uses).
// Handles only, never real names; no other person's certificate is shown.

export const REWARDS_INTRO = {
  title: "Rewards and ranks",
  subtitle:
    "Every class, lecture and plan earns XP. XP sets your rank, the weekly leaderboard turns it into prizes, and certificates prove it.",
};

export const XP_WAYS = [
  { key: "live", value: "150 XP", label: "Live class, 40+ minutes", note: "+100 for your first" },
  { key: "partial", value: "30 XP", label: "Partial live class", note: "Under 40 minutes" },
  { key: "recordings", value: "1 XP / 5 min", label: "Recordings", note: "Up to 60 a day, +20 per finished lecture" },
  { key: "plans", value: "₹ × 0.5 XP", label: "Subscriptions", note: "Half an XP per rupee" },
];

/**
 * Weekly report XP (mirrors backend rules.REPORT_MARK_BONUS, the default of
 * ENGAGEMENT_REPORT_MARK_BONUS): every submitted report earns the base XP, and
 * the graded score out of 10 (rounded down) adds a bonus tier.
 */
export const REPORT_BASE_XP = { submitted: 30, onTime: 40 };

export const REPORT_MARK_BONUS = [
  { score: 10, xp: 300, label: "Perfect report" },
  { score: 9, xp: 200, label: "Excellent" },
  { score: 8, xp: 130, label: "Strong" },
  { score: 7, xp: 80, label: "Good" },
  { score: 6, xp: 40, label: "Pass" },
];

export const REPORT_BONUS_NOTE = "Below 6/10 earns the submission XP only. A regrade adjusts the bonus up or down.";

export const WEEKLY_PRIZES = [
  { place: "#1", xp: "200 XP", label: "Top of the week" },
  { place: "#2–3", xp: "120 XP", label: "Runners-up" },
  { place: "#4–10", xp: "60 XP", label: "Top ten" },
];

export const RANKS_NOTE = "Recruit to Elite Operator: every rank is earned in XP, never bought.";

/** The example student in the code-built mock (a handle, never a name). */
export const MOCK_STUDENT = { xp: 4800 };

export const MOCK_BOARD = [
  { place: 1, handle: "@shadowtrace", xp: 1240 },
  { place: 2, handle: "@geo_hound", xp: 1105, you: true },
  { place: 3, handle: "@pivotpoint", xp: 980 },
];

/** Grouped badge catalogue (mirrors backend apps/engagement/badges.py). */
export const BADGE_GROUPS = [
  {
    key: "lectures",
    title: "Lectures and courses",
    badges: [
      { key: "first_lecture", title: "First Lecture", tier: "bronze", description: "Complete your first lecture." },
      { key: "lecture_10", title: "Ten Down", tier: "silver", description: "Complete 10 lectures." },
      { key: "lecture_50", title: "Half Century", tier: "gold", description: "Complete 50 lectures." },
      { key: "course_finisher", title: "Course Finisher", tier: "gold", description: "Complete every lecture of a course." },
      { key: "deep_focus", title: "Deep Focus", tier: "silver", description: "Reach the daily watch-time XP cap." },
    ],
  },
  {
    key: "streaks",
    title: "Streaks and habits",
    badges: [
      { key: "streak_3", title: "On a Roll", tier: "bronze", description: "Keep a 3-day study streak." },
      { key: "streak_7", title: "Week Warrior", tier: "silver", description: "Keep a 7-day study streak." },
      { key: "streak_30", title: "Unbreakable", tier: "gold", description: "Keep a 30-day study streak." },
      { key: "streak_100", title: "Centurion", tier: "platinum", description: "Keep a 100-day study streak." },
      { key: "weekend_warrior", title: "Weekend Warrior", tier: "bronze", description: "Study on both days of a weekend." },
      { key: "comeback", title: "Comeback", tier: "bronze", description: "Return to study after a week or more away." },
      { key: "night_owl", title: "Night Owl", tier: "bronze", description: "Earn XP between midnight and 4 am (IST)." },
      { key: "early_bird", title: "Early Bird", tier: "bronze", description: "Earn XP between 5 am and 7 am (IST)." },
    ],
  },
  {
    key: "reports",
    title: "Reports and exams",
    badges: [
      { key: "first_report", title: "First Report", tier: "bronze", description: "Submit your first weekly report." },
      { key: "report_ranger", title: "Report Ranger", tier: "silver", description: "Submit 10 weekly reports." },
      { key: "punctual", title: "Punctual", tier: "silver", description: "Submit 5 weekly reports on time." },
      { key: "sharp_analyst", title: "Sharp Analyst", tier: "gold", description: "Score 90% or more on 5 graded reports." },
      { key: "perfect_score", title: "Perfect Score", tier: "gold", description: "Score 100% on a graded report or an exam." },
      { key: "first_exam", title: "First Exam", tier: "bronze", description: "Finish your first exam." },
      { key: "exam_ace", title: "Exam Ace", tier: "gold", description: "Score 90% or more in an exam." },
      { key: "batch_top_3", title: "Batch Top 3", tier: "platinum", description: "Finish an exam in the top 3 of your batch." },
    ],
  },
  {
    key: "live",
    title: "Live classes and XP",
    badges: [
      { key: "first_live", title: "First Live Class", tier: "bronze", description: "Attend your first live class." },
      { key: "live_regular", title: "Live Regular", tier: "silver", description: "Attend 10 live classes." },
      { key: "live_devotee", title: "Live Devotee", tier: "gold", description: "Attend 25 live classes." },
      { key: "xp_1000", title: "Thousand Club", tier: "silver", description: "Earn 1,000 XP." },
      { key: "xp_5000", title: "Five Thousand", tier: "gold", description: "Earn 5,000 XP." },
      { key: "podium_week", title: "Podium Week", tier: "gold", description: "Finish a week in the top 3 of your batch leaderboard." },
    ],
  },
];

export const TIER_LABELS = { bronze: "Bronze", silver: "Silver", gold: "Gold", platinum: "Platinum" };

export const MONTHLY_CTF = {
  title: "Monthly OSINT CTF",
  body: "One free OSINT challenge every month for every registered student, with its own leaderboard.",
  rewards: [
    { lead: "XP for every clean solve.", text: "Added to your total the day the season closes." },
    { lead: "The Golden Aura.", text: "The fastest clean solve wears it on their handle for a month." },
    { lead: "Podium frames and trophies.", text: "For the top three of the month." },
    { lead: "Finalist certificates.", text: "Private to the finalist, like every certificate." },
  ],
};

export const CERTIFICATES_INFO = {
  title: "Certificates",
  body: "Pass the course exam and your certificate is issued with a reference number and a QR code.",
  points: [
    { lead: "Private to you.", text: "Only you (signed in) can open the full certificate and download it." },
    { lead: "Verifiable.", text: "Anyone with the reference can check that it is valid, without seeing your name." },
    { lead: "On your profile.", text: "Highlight it on your public profile as a badge, shown under your handle." },
  ],
};

export const RECORD_POINTS = [
  { lead: "Badges.", text: "Earned for streaks, reports, labs and exams." },
  { lead: "Weekly leaderboard.", text: "Handles only, never real names." },
  { lead: "Monthly CTF.", text: "The fastest clean solve wears the Golden Aura for a month." },
  { lead: "Certificates.", text: "Private to you; anyone can check one is valid by its reference." },
  { lead: "Hall of Fame.", text: "Every certified graduate, batch by batch, by chosen handle." },
];

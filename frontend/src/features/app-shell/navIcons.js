import {
  Add,
  Book,
  Catalog,
  Collaborate,
  Dashboard,
  Education,
  Flag,
  Home,
  Identification,
  Microphone,
  PlayOutline,
  QuestionAnswering,
  Report,
  TaskApproved,
  ToolKit,
  UserAvatar,
  Video,
} from "@carbon/icons-react";

// Maps navConfig icon keys to Carbon icons (kept separate so navConfig stays pure).
export const NAV_ICONS = {
  overview: Home,
  courses: Education,
  continue: PlayOutline,
  live: Video,
  guides: Book,
  tools: ToolKit,
  profile: UserAvatar,
  idCard: Identification,
  instructor: Catalog,
  add: Add,
  dashboard: Dashboard,
  meeting: Collaborate,
  broadcast: Microphone,
  questions: QuestionAnswering,
  labs: Flag,
  reports: Report,
  grading: TaskApproved,
};

export function getNavIcon(key) {
  return NAV_ICONS[key] || Education;
}

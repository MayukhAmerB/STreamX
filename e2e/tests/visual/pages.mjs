// Visual regression page list (UI overhaul plan, Appendix A.4). OWNER: WS-I.
//
// Every entry is captured at 390x844 (project "mobile") and 1440x900 (project
// "desktop") by visual.spec.mjs and checked by a11y.spec.mjs. Paths with ids
// are resolved from the seed manifest (backend/apps/e2e_support/seeding.py).
//
//   id        unique, stable, used as the baseline file name
//   persona   who looks at it (see PERSONAS in stage.mjs)
//   path      a string or (manifest) => string
//   fixtures  extra /api/__e2e__/fixture/<name>/ calls before the visit
//   note      what the page should show (for the reviewer)

export const PAGES = [
  // Student (Learn workspace)
  { id: "student-home", persona: "student", path: "/console", note: "Home: Next up first, action above the fold" },
  { id: "student-courses", persona: "student", path: "/my-courses", note: "Courses (T2)" },
  { id: "student-player", persona: "student", path: (m) => `/learn/${m.course.id}`, note: "Player (T5 focus mode)" },
  { id: "student-live", persona: "student", path: "/join-live", note: "Live classes, off air" },
  { id: "student-coursework", persona: "student", path: "/reports", note: "Coursework: This week" },
  { id: "student-grades", persona: "student", path: "/gradebook", note: "Coursework: Grades" },
  { id: "student-exams", persona: "student", path: "/coursework/exams", note: "Coursework: Exams (one open)" },
  { id: "student-osint-tools", persona: "student", path: "/osint-tools", note: "Practice: OSINT tools" },
  { id: "student-profile", persona: "student", path: "/profile", note: "Profile (Reduce motion toggle)" },

  // A signed-in user with no course
  { id: "nocourse-home", persona: "nocourse", path: "/console", note: "Home: Browse courses, no countdown" },
  { id: "nocourse-coursework", persona: "nocourse", path: "/reports", note: "Coursework empty state" },

  // Instructor, Teachers section OFF (production default)
  { id: "instructor-off-home", persona: "instructorOff", path: "/console", note: "Learn + Teach disabled with reason" },
  { id: "instructor-off-teach", persona: "instructorOff", path: "/console/teach", note: "Teaching is switched off page" },

  // Instructor, Teachers section ON
  { id: "instructor-teach-today", persona: "instructorOn", path: "/console/teach", note: "Teach Today (T1)" },
  { id: "instructor-teach-courses", persona: "instructorOn", path: "/console/teach/courses", note: "Courses (T2)" },
  {
    id: "instructor-teach-course",
    persona: "instructorOn",
    path: (m) => `/console/teach/courses/${m.course.id}`,
    note: "Course editor (T3 tabs)",
  },
  { id: "instructor-teach-classes", persona: "instructorOn", path: "/console/teach/classes", note: "Classes (T2)" },
  {
    id: "instructor-teach-upload",
    persona: "instructorOn",
    path: "/console/teach/recordings/upload",
    note: "Upload recording (T4)",
  },
  { id: "instructor-teach-grading", persona: "instructorOn", path: "/console/teach/grading", note: "Grading, Queue first" },
  { id: "instructor-teach-exams", persona: "instructorOn", path: "/console/teach/exams", note: "Exams (T2)" },

  // Staff (Admin workspace); queues populated by the admin-queues fixture
  {
    id: "staff-admin-home",
    persona: "staff",
    path: "/console/admin",
    fixtures: ["admin-queues"],
    note: "Admin home: needs attention, one champagne button",
  },
  { id: "staff-admin-home-clear", persona: "staff", path: "/console/admin", note: "Admin home: all clear" },
  {
    id: "staff-admin-requests",
    persona: "staff",
    path: "/console/admin/requests",
    fixtures: ["admin-queues"],
    note: "Requests with inline approve/reject",
  },
  {
    id: "staff-admin-recordings",
    persona: "staff",
    path: "/console/admin/recordings",
    fixtures: ["admin-queues"],
    note: "Recordings (one list over 3 models)",
  },
  { id: "staff-admin-features", persona: "staff", path: "/console/admin/settings/features", note: "Feature switches" },
  { id: "staff-admin-health", persona: "staff", path: "/console/admin/system/health", note: "System health" },
  {
    id: "staff-admin-studio",
    persona: "staff",
    path: (m) => `/console/admin/classes/${m.sessions.obs.id}/studio`,
    note: "Host studio (T5)",
  },

  // Django back office ("Al Syed Admin")
  { id: "django-index", persona: "backoffice", path: "/admin/", fixtures: ["admin-queues"], note: "Overview" },
  {
    id: "django-payments",
    persona: "backoffice",
    path: "/admin/payments/payment/",
    fixtures: ["admin-queues"],
    note: "Payments changelist",
  },
  {
    id: "django-course-change",
    persona: "backoffice",
    path: (m) => `/admin/courses/course/${m.course.id}/change/`,
    note: "Course change form",
  },
  { id: "django-features", persona: "backoffice", path: "/admin/core/featureflag/", note: "Settings > Features" },

  // Public website
  { id: "public-landing", persona: "public", path: "/", note: "Landing" },
  { id: "public-courses", persona: "public", path: "/courses", note: "Course list" },
  { id: "public-course", persona: "public", path: (m) => `/courses/${m.course.id}`, note: "Course detail" },
  { id: "public-login", persona: "public", path: "/login", note: "Login" },
  { id: "public-not-found", persona: "public", path: "/does-not-exist", note: "404" },
];

/** Routes the motion probes visit (plan §2.4 runtime probe). */
export const MOTION_PAGES = [
  { id: "public-landing", persona: "public", path: "/" },
  { id: "student-home", persona: "student", path: "/console" },
  { id: "staff-admin-home", persona: "staff", path: "/console/admin", fixtures: ["admin-queues"] },
  { id: "django-index", persona: "backoffice", path: "/admin/", fixtures: ["admin-queues"] },
];

export function resolvePath(entry, manifest) {
  return typeof entry.path === "function" ? entry.path(manifest) : entry.path;
}

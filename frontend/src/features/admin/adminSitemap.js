// The Console Admin map (UI overhaul plan §4.2/§4.3). OWNER: WS-G.
// One list of jobs, shared by the Admin home (quick actions), the command
// palette (tasks and sections) and anything else that needs "where is X".
// Wave-2 pages open their back-office page until they are built.

export const ADMIN_ROOT = "/console/admin";

export const ADMIN_GROUPS = Object.freeze([
  { key: "today", label: "Today" },
  { key: "live", label: "Live classes" },
  { key: "content", label: "Content" },
  { key: "students", label: "Students & sales" },
  { key: "assessments", label: "Assessments" },
  { key: "community", label: "Community" },
  { key: "settings", label: "Settings" },
  { key: "system", label: "System" },
]);

const GROUP_LABEL = Object.fromEntries(ADMIN_GROUPS.map((group) => [group.key, group.label]));

const dest = (group, title, href, keywords = []) => ({ group: GROUP_LABEL[group], groupKey: group, title, href, keywords });

/** Every Admin page, in nav order. */
export const ADMIN_DESTINATIONS = Object.freeze([
  dest("today", "Admin home", ADMIN_ROOT, ["attention", "overview", "dashboard"]),
  dest("today", "Activity", `${ADMIN_ROOT}/activity`, ["audit", "history", "log", "changes"]),
  dest("live", "Classes and studio", `${ADMIN_ROOT}/classes`, ["live", "broadcast", "meeting", "obs", "stream"]),
  dest("live", "Live chat moderation", `${ADMIN_ROOT}/classes/chat`, ["chat", "handles", "owncast"]),
  dest("content", "Courses", `${ADMIN_ROOT}/courses`, ["curriculum", "lectures", "modules"]),
  dest("content", "Recordings", `${ADMIN_ROOT}/recordings`, ["videos", "review", "publish"]),
  dest("content", "Upload a recording", `${ADMIN_ROOT}/recordings/upload`, ["obs", "video", "file"]),
  dest("students", "Requests", `${ADMIN_ROOT}/requests`, ["enrolment", "enrollment", "approve", "access"]),
  dest("students", "Payments", `${ADMIN_ROOT}/payments`, ["orders", "refund", "razorpay", "credentials"]),
  dest("students", "People", `${ADMIN_ROOT}/people`, ["users", "students", "instructors", "accounts"]),
  dest("students", "Batches", `${ADMIN_ROOT}/batches`, ["batch pass"]),
  dest("students", "Leads and forms", `${ADMIN_ROOT}/leads`, ["join", "applications", "enquiries"]),
  dest("assessments", "Grading", `${ADMIN_ROOT}/grading`, ["reports", "marks", "queue", "weekly"]),
  dest("assessments", "Exams", `${ADMIN_ROOT}/exams`, ["ctf", "osint", "results"]),
  dest("community", "Questions", `${ADMIN_ROOT}/community?tab=questions`, ["lecture questions", "answer"]),
  dest("settings", "Features", `${ADMIN_ROOT}/settings/features`, ["switches", "teachers", "teaching", "toggle"]),
  dest("settings", "Website", `${ADMIN_ROOT}/settings/website`, ["youtube", "media"]),
  dest("settings", "Live config", `${ADMIN_ROOT}/settings/live`, ["realtime", "livekit", "owncast"]),
  dest("system", "Health", `${ADMIN_ROOT}/system/health`, ["outbox", "jobs", "errors", "server"]),
  dest("system", "Upload tokens", `${ADMIN_ROOT}/system/tokens`, ["desktop uploader", "api"]),
  dest("system", "Back office", "/admin/", ["django", "admin"]),
]);

/** Static jobs (palette "Tasks" and the home's quick actions). */
export const ADMIN_TASKS = Object.freeze([
  { key: "go-live", title: "Go live", subtitle: "Open the studio for a class", href: `${ADMIN_ROOT}/classes?mode=broadcast`, keywords: ["broadcast", "stream", "obs"], quick: true },
  { key: "upload-recording", title: "Upload a recording", subtitle: "Add the OBS file of a class", href: `${ADMIN_ROOT}/recordings/upload`, keywords: ["video", "obs"], quick: true },
  { key: "new-class", title: "New live class", subtitle: "Schedule a class session", href: `${ADMIN_ROOT}/classes?mode=meeting`, keywords: ["meeting", "session", "schedule"], quick: true },
  { key: "import-exam", title: "Import an exam", subtitle: "Load an exam JSON file", href: `${ADMIN_ROOT}/exams`, keywords: ["ctf", "json"], quick: true },
  { key: "new-report-task", title: "New report task", subtitle: "Set a weekly target", href: `${ADMIN_ROOT}/grading/tasks/new`, keywords: ["weekly", "target", "report"], quick: true },
  { key: "features", title: "Turn features on or off", subtitle: "Teachers section and other switches", href: `${ADMIN_ROOT}/settings/features`, keywords: ["teachers", "teaching", "switch", "toggle"], quick: true },
  { key: "review-requests", title: "Review requests", subtitle: "Approve or reject access requests", href: `${ADMIN_ROOT}/requests`, keywords: ["enrolment", "approve"] },
  { key: "back-office-payments", title: "Open back office: Payments", subtitle: "Orders, refunds and credentials", href: "/admin/payments/payment/", keywords: ["refund", "razorpay"] },
  { key: "back-office-people", title: "Open back office: People", subtitle: "Users and roles", href: "/admin/users/user/", keywords: ["users", "role"] },
  { key: "back-office-leads", title: "Open back office: Join forms", subtitle: "Join Al Syed applications", href: "/admin/join_requests/joinapplication/", keywords: ["leads", "applications"] },
  { key: "back-office", title: "Open back office", subtitle: "Every record, setting and audit", href: "/admin/", keywords: ["django"] },
]);

export const QUICK_ACTIONS = Object.freeze(ADMIN_TASKS.filter((task) => task.quick));

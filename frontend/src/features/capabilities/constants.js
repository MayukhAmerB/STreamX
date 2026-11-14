// OWNER: WS-F. Shared capability keys (match backend apps/users/capabilities.py).

export const WORKSPACES = Object.freeze(["learn", "teach", "admin"]);

// Feature → the workspace it opens for non-staff viewers.
export const FEATURE_WORKSPACES = Object.freeze({ teaching: "teach" });

// Nav item ids gated by `caps.items` (Teach workspace, plan §3.2).
export const TEACH_ITEM_KEYS = Object.freeze([
  "teach-today",
  "teach-courses",
  "teach-classes",
  "teach-recordings",
  "teach-grading",
  "teach-exams",
]);

export const FEATURES_MANAGE_URL = "/console/admin/settings/features";

// Owner privacy rule (handle only): inside the app another student is shown by
// their profile HANDLE, never their real name or e-mail. Real names appear only
// on certificates and in the student's own account settings. Staff screens
// (grading, payments, attendance, exports) keep the identity block instead.
//
// The server already sends handles on student-facing payloads; these helpers
// make sure UI code reads the handle field first and never falls back to a
// real-name field.

/** True for instructors and staff, who teach under their own name. */
export function isStaffLike(user) {
  return Boolean(user && (user.is_staff || user.is_superuser || user.role === "instructor"));
}

/**
 * The name to print for another person on a student-facing surface:
 * `handle`, then the server's `display_name` (itself a handle for students),
 * then `fallback`. `full_name` / `email` are deliberately never read.
 */
export function publicName(person, fallback = "Learner") {
  if (!person) return fallback;
  if (typeof person === "string") return person.trim() || fallback;
  const value = String(person.handle || person.display_name || "").trim();
  return value || fallback;
}

/**
 * `display_name` sent when joining a live class. Students send nothing (the
 * server names them by their handle for other participants); instructors and
 * staff may send their account name.
 */
export function liveJoinDisplayName(user) {
  return isStaffLike(user) ? String(user.full_name || "").trim() : "";
}

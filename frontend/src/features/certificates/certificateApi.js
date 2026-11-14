// Public certificate API. OWNER: WS-CERTIFICATES.
// GET /api/engagement/certificates/<reference or slug>/ needs no sign-in and
// works whatever the engagement switch says. A slug or a loosely typed
// reference answers 301 to the canonical reference (the browser follows it),
// so the payload's `reference` is the address to show.
import apiClient from "../../api/client";

export async function fetchCertificate(identifier) {
  const response = await apiClient.get(`/engagement/certificates/${encodeURIComponent(String(identifier || "").trim())}/`);
  return response?.data?.data ?? null;
}

/** "missing" | "typo" | "invalid" | "busy" | "error" for a failed lookup. */
export function certificateErrorKind(error) {
  const status = error?.response?.status;
  const data = error?.response?.data || {};
  const code = data.code || data.errors?.code;
  if (status === 404) return "missing";
  if (status === 400 && code === "certificate_reference_typo") return "typo";
  if (status === 400) return "invalid";
  if (status === 429) return "busy";
  return "error";
}

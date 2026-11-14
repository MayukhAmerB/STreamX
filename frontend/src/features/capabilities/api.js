// OWNER: WS-F. GET /api/me/capabilities/ (Appendix A.1).
//
// The server sends an ETag with `Cache-Control: private, no-cache`, so the
// browser revalidates each poll and a 304 costs no body.
import apiClient, { CAPABILITIES_STALE_EVENT, FEATURE_DISABLED_CODE, featureDisabledDetail } from "../../api/client";

export { CAPABILITIES_STALE_EVENT, FEATURE_DISABLED_CODE, featureDisabledDetail };

export const fetchCapabilities = () => apiClient.get("/me/capabilities/");

// Re-check on window focus and every 5 minutes (plan §5.4).
export const CAPABILITIES_POLL_MS = 5 * 60 * 1000;

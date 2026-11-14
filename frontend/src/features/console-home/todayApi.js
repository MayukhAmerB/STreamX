// GET /api/console/today/ (plan Appendix A.2). OWNER: WS-C.
import apiClient from "../../api/client";

export const getToday = (workspace = "learn") => apiClient.get("/console/today/", { params: { workspace } });

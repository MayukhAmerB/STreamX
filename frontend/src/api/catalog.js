// Public catalogue, free OSINT directory and labs entitlement (contract
// hackpath/contracts/catalog.md §1, §3, §4). Thin wrappers: every function
// resolves to the `data` block of the API envelope.
import apiClient from "./client";

const data = (response) => {
  const body = response?.data;
  return body && typeof body === "object" && "data" in body ? body.data : body;
};

/** GET /api/catalog/ — tracks, tiers, gates, plans, free challenges, labs tabs. */
export const fetchCatalog = () => apiClient.get("/catalog/").then(data);

/** GET /api/labs/directory/ — free challenges (link-out), paths and, when signed in, `me`. */
export const fetchDirectory = () => apiClient.get("/labs/directory/").then(data);

/** POST /api/labs/directory/<slug>/progress/ — `{done, flag?}`; 400 `flag_incorrect` for a wrong flag. */
export const markDirectoryDone = (slug, { done = true, flag } = {}) =>
  apiClient
    .post(`/labs/directory/${encodeURIComponent(slug)}/progress/`, flag === undefined ? { done } : { done, flag })
    .then(data);

/** GET /api/labs/policy/ — is the labs site members-only right now? */
export const fetchLabsPolicy = () => apiClient.get("/labs/policy/").then(data);

/** GET /api/labs/entitlement/ — the signed-in viewer's labs access. */
export const fetchLabsEntitlement = () => apiClient.get("/labs/entitlement/").then(data);

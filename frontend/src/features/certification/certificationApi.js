// Certification API client (`/api/certification/*`).
//
// The Hall of Fame is public and shows HANDLES only (owner rule): the backend
// never sends a real name or e-mail on that endpoint.
import apiClient from "../../api/client";
import { apiData } from "../../utils/api";

const unwrap = (response) => apiData(response, null);

/** `{ counters, featured: { recent, top }, batches, entries, page, total, has_more }`. */
export const fetchHallOfFame = ({ page = 1, batch = "" } = {}) =>
  apiClient.get("/certification/hall-of-fame/", { params: batch ? { page, batch } : { page } }).then(unwrap);

/** `{ delivery_channel, whatsapp_opt_out, hall_of_fame_listed, has_phone, whatsapp_available }`. */
export const fetchCertificationPreferences = () => apiClient.get("/certification/me/preferences/").then(unwrap);

export const saveCertificationPreferences = (changes) =>
  apiClient.patch("/certification/me/preferences/", changes).then(unwrap);

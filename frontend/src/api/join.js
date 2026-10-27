import apiClient from "./client";

export const listJoinLocations = () => apiClient.get("/join/locations/");
export const getJoinSettings = () => apiClient.get("/join/settings/");
export const submitJoinApplication = (payload) => apiClient.post("/join/applications/", payload);

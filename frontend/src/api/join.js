import apiClient from "./client";

export const listJoinLocations = () => apiClient.get("/join/locations/");
export const submitJoinApplication = (payload) => apiClient.post("/join/applications/", payload);

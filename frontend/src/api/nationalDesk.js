import apiClient from "./client";

export const getNationalDesk = () => apiClient.get("/national-desk/");

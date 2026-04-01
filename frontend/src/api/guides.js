import apiClient from "./client";
import { dedupedGet } from "./requestDedup";

export const listGuides = () =>
  dedupedGet("/guides/", {}, () => apiClient.get("/guides/"));

export const getGuideVideoUrl = (id) =>
  dedupedGet(`/guides/${id}/video/`, {}, () => apiClient.get(`/guides/${id}/video/`));

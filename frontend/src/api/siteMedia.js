import apiClient from "./client";

/** Public YouTube section data (channel, live status, featured and latest videos). */
export const getYouTubeChannel = () => apiClient.get("/site/youtube/");

import apiClient from "./client";

export const fetchNotifications = (params = {}) => apiClient.get("/notifications/", { params });
export const markNotificationRead = (id) => apiClient.post(`/notifications/${id}/read/`);
export const markAllNotificationsRead = () => apiClient.post("/notifications/read-all/");
export const registerPushSubscription = (subscription) =>
  apiClient.post("/notifications/push-subscriptions/", subscription);

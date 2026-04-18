const PUSH_WORKER_PATH = "/push-worker.js";

export function isPushSupported() {
  return Boolean(
    typeof window !== "undefined" &&
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window
  );
}

export async function requestNotificationPermission() {
  if (!isPushSupported()) {
    return "unsupported";
  }
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  return Notification.requestPermission();
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export async function subscribeToBrowserPush(publicKey) {
  if (!isPushSupported() || Notification.permission !== "granted" || !publicKey) {
    return null;
  }
  const registration = await navigator.serviceWorker.register(PUSH_WORKER_PATH);
  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) {
    return existingSubscription.toJSON();
  }
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  return subscription.toJSON();
}

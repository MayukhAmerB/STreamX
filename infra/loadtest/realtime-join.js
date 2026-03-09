import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8000";
const SESSION_ID = __ENV.SESSION_ID || "";
const AUTH_TOKEN = __ENV.AUTH_TOKEN || "";
const SLEEP_SECONDS = Number(__ENV.SLEEP_SECONDS || 1);
const JOIN_PATH = `/api/realtime/sessions/${SESSION_ID}/join/`;

if (!SESSION_ID) {
  throw new Error("SESSION_ID is required.");
}

if (!AUTH_TOKEN) {
  throw new Error("AUTH_TOKEN is required.");
}

export const options = {
  scenarios: {
    joiners: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || "3m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2500"],
  },
};

export default function () {
  const payload = JSON.stringify({
    display_name: `LoadUser-${__VU}-${__ITER}`,
  });

  const response = http.post(`${BASE_URL}${JOIN_PATH}`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  });

  check(response, {
    "join returned 200": (r) => r.status === 200,
    "join success payload": (r) => {
      const parsed = r.json();
      return Boolean(parsed && parsed.success === true && parsed.data);
    },
  });

  sleep(SLEEP_SECONDS);
}

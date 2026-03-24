import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8000";
const SESSION_ID = __ENV.SESSION_ID || "";
const AUTH_TOKEN = (__ENV.AUTH_TOKEN || "").trim();
const AUTH_TOKENS_ENV = __ENV.AUTH_TOKENS || "";
const AUTH_TOKENS_FILE = __ENV.AUTH_TOKENS_FILE || "";
const VUS = Number(__ENV.VUS || 50);
const SLEEP_SECONDS = Number(__ENV.SLEEP_SECONDS || 1);
const PREFER_BROADCAST = parseBoolean(__ENV.PREFER_BROADCAST || "false");
const DEBUG_ERRORS = parseBoolean(__ENV.DEBUG_ERRORS || "false");
const JOIN_ONCE = parseBoolean(__ENV.JOIN_ONCE || "false");
const HOLD_AFTER_JOIN_SECONDS = Number(__ENV.HOLD_AFTER_JOIN_SECONDS || 0);
const SPREAD_REJOINS_PER_USER = Number(__ENV.SPREAD_REJOINS_PER_USER || 0);
const SPREAD_WINDOW_SECONDS = Number(__ENV.SPREAD_WINDOW_SECONDS || 0);
const SPREAD_JITTER_SECONDS = Number(__ENV.SPREAD_JITTER_SECONDS || 0);
const JOIN_PATH = `/api/realtime/sessions/${SESSION_ID}/join/`;
const VU_START_TIMES_MS = {};

if (!SESSION_ID) {
  throw new Error("SESSION_ID is required.");
}

const AUTH_TOKENS = loadAuthTokens();

if (!AUTH_TOKENS.length) {
  throw new Error("Set AUTH_TOKEN, AUTH_TOKENS, or AUTH_TOKENS_FILE.");
}

if (AUTH_TOKENS.length < VUS) {
  console.warn(
    `[loadtest] ${AUTH_TOKENS.length} auth token(s) configured for ${VUS} VUs. ` +
      "Reusing tokens can trigger per-user throttles and skew results.",
  );
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function splitTokens(rawValue) {
  return String(rawValue || "")
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function loadAuthTokens() {
  const tokens = [];

  if (AUTH_TOKEN) {
    tokens.push(AUTH_TOKEN);
  }

  tokens.push(...splitTokens(AUTH_TOKENS_ENV));

  if (AUTH_TOKENS_FILE) {
    tokens.push(...splitTokens(open(AUTH_TOKENS_FILE)));
  }

  return tokens;
}

function getTokenForVu(vu) {
  const tokenIndex = (Math.max(1, vu) - 1) % AUTH_TOKENS.length;
  return AUTH_TOKENS[tokenIndex];
}

function summarizeResponse(response) {
  const contentType = String(response.headers["Content-Type"] || response.headers["content-type"] || "");
  const bodyText = typeof response.body === "string" ? response.body.trim() : "";
  const looksLikeJson =
    contentType.toLowerCase().includes("application/json") ||
    bodyText.startsWith("{") ||
    bodyText.startsWith("[");

  if (!looksLikeJson) {
    return {
      isJson: false,
      parsed: null,
      preview: bodyText.slice(0, 240),
      parseError: "",
      contentType,
    };
  }

  try {
    return {
      isJson: true,
      parsed: response.json(),
      preview: bodyText.slice(0, 240),
      parseError: "",
      contentType,
    };
  } catch (error) {
    return {
      isJson: false,
      parsed: null,
      preview: bodyText.slice(0, 240),
      parseError: error && error.message ? String(error.message) : "Unable to parse JSON response.",
      contentType,
    };
  }
}

function logJoinFailure(response, details) {
  if (!DEBUG_ERRORS) {
    return;
  }

  const reason = details.parseError || (details.isJson ? "unexpected_json_payload" : "non_json_response");
  console.error(
    `[join failure] vu=${__VU} iter=${__ITER} status=${response.status} reason=${reason} ` +
      `content_type=${details.contentType || "unknown"} preview=${JSON.stringify(details.preview)}`,
  );
}

function sleepUntilOffsetSeconds(offsetSeconds) {
  const startedAt = VU_START_TIMES_MS[__VU] || Date.now();
  const targetTimeMs = startedAt + Math.max(0, offsetSeconds) * 1000;
  const remainingSeconds = (targetTimeMs - Date.now()) / 1000;
  if (remainingSeconds > 0) {
    sleep(remainingSeconds);
  }
}

function spreadOffsetSeconds(iterationIndex) {
  const baseIntervalSeconds = SPREAD_WINDOW_SECONDS / SPREAD_REJOINS_PER_USER;
  const slotStartSeconds = (iterationIndex - 1) * baseIntervalSeconds;
  const jitterSeconds = SPREAD_JITTER_SECONDS > 0 ? Math.random() * SPREAD_JITTER_SECONDS : 0;
  return slotStartSeconds + jitterSeconds;
}

function performJoin() {
  const payloadBody = {
    display_name: `LoadUser-${__VU}-${__ITER}`,
  };
  if (PREFER_BROADCAST) {
    payloadBody.prefer_broadcast = true;
  }

  const payload = JSON.stringify(payloadBody);

  const response = http.post(`${BASE_URL}${JOIN_PATH}`, payload, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getTokenForVu(__VU)}`,
    },
  });
  const responseDetails = summarizeResponse(response);
  const joinSucceeded = Boolean(
    response.status === 200 &&
      responseDetails.isJson &&
      responseDetails.parsed &&
      responseDetails.parsed.success === true &&
      responseDetails.parsed.data,
  );

  if (!joinSucceeded) {
    logJoinFailure(response, responseDetails);
  }

  check(response, {
    "join returned 200": (r) => r.status === 200,
    "join success payload": () => joinSucceeded,
  });
}

export const options = {
  scenarios: {
    joiners: {
      executor: "constant-vus",
      vus: VUS,
      duration: __ENV.DURATION || "3m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2500"],
  },
};

export default function () {
  if (!VU_START_TIMES_MS[__VU]) {
    VU_START_TIMES_MS[__VU] = Date.now();
  }

  if (SPREAD_REJOINS_PER_USER > 0) {
    if (__ITER === 0) {
      performJoin();
      return;
    }

    if (__ITER <= SPREAD_REJOINS_PER_USER) {
      sleepUntilOffsetSeconds(spreadOffsetSeconds(__ITER));
      performJoin();
      return;
    }

    sleep(SLEEP_SECONDS);
    return;
  }

  if (JOIN_ONCE && __ITER > 0) {
    sleep(HOLD_AFTER_JOIN_SECONDS > 0 ? HOLD_AFTER_JOIN_SECONDS : SLEEP_SECONDS);
    return;
  }

  performJoin();

  if (JOIN_ONCE) {
    sleep(HOLD_AFTER_JOIN_SECONDS > 0 ? HOLD_AFTER_JOIN_SECONDS : SLEEP_SECONDS);
    return;
  }

  sleep(SLEEP_SECONDS);
}

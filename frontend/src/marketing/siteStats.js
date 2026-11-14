// Live website figures from GET /api/site/stats/ (counted from real records on
// the server, cached there for 10 minutes). Every figure is optional: the
// server sends null for a figure below its display minimum, and the strips
// that show these figures render nothing when no figure is left or the request
// fails. Formatting is honest: a number is never rounded up, and "+" appears
// only when the real value is above the number shown ("130+" means >= 130).
import { useEffect, useState } from "react";

import apiClient from "../api/client";

const URL = "/site/stats/";
const TTL_MS = 10 * 60 * 1000;

/** Defensive client-side minimums (the server applies the same ones). */
export const SITE_STAT_MINIMUMS = Object.freeze({
  students_enrolled: 25,
  live_classes_delivered: 10,
  recorded_hours: 10,
  certificates_issued: 10,
  ctf_cases: 5,
});
export const MIN_REVIEWS_FOR_RATING = 10;

/** Display order and labels. */
export const SITE_STAT_LABELS = Object.freeze([
  ["students_enrolled", "Students enrolled"],
  ["live_classes_delivered", "Live classes delivered"],
  ["recorded_hours", "Hours of recorded classes"],
  ["certificates_issued", "Certificates issued"],
  ["ctf_cases", "CTF challenges and cases"],
]);
export const RATING_LABEL = "Average course rating";

const asCount = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);

/**
 * The number to show for a count, never above the real value:
 * below 100 exact; then rounded DOWN to a step (10, 100, 1,000) with "+" only
 * when the shown number is below the real one. 134 -> 130+, 130 -> 130, 1234 -> 1,200+.
 */
export function honestCount(value) {
  const real = asCount(value);
  if (real === null) return null;
  const step = real < 100 ? 1 : real < 1000 ? 10 : real < 10000 ? 100 : 1000;
  const shown = Math.floor(real / step) * step;
  const plus = shown < real;
  return { shown, plus, text: `${shown.toLocaleString("en-US")}${plus ? "+" : ""}` };
}

function unwrap(body) {
  if (!body || typeof body !== "object") return {};
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data) && ("success" in body || "errors" in body)) return body.data;
  return body;
}

/**
 * Display items from the API payload (the envelope or its `data`), in a fixed
 * order: { key, label, value (final text), count (number to count up to, or
 * null for text-only figures), plus, note }. Hidden figures are left out.
 */
export function siteStatItems(payload) {
  const data = unwrap(payload);
  const stats = data?.stats && typeof data.stats === "object" && !Array.isArray(data.stats) ? data.stats : {};
  const items = [];
  for (const [key, label] of SITE_STAT_LABELS) {
    const real = asCount(stats[key]);
    if (real === null || real < SITE_STAT_MINIMUMS[key]) continue;
    const { shown, plus, text } = honestCount(real);
    items.push({ key, label, value: text, count: shown, plus, note: "" });
  }
  const rating = Number(stats.average_rating);
  const reviews = asCount(stats.rating_count);
  if (stats.average_rating !== null && Number.isFinite(rating) && rating >= 1 && rating <= 5 && reviews !== null && reviews >= MIN_REVIEWS_FOR_RATING) {
    const floored = Math.floor(rating * 10 + 1e-9) / 10;
    items.push({
      key: "average_rating",
      label: RATING_LABEL,
      value: `${floored.toFixed(1)}/5`,
      count: null,
      plus: false,
      note: `from ${reviews.toLocaleString("en-US")} reviews`,
    });
  }
  return items;
}

const cache = { at: 0, promise: null };

/** One shared request per 10 minutes; resolves to { status, items } and never rejects. */
export function fetchSiteStats({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.promise && now - cache.at < TTL_MS) return cache.promise;
  cache.at = now;
  cache.promise = apiClient
    .get(URL)
    .then((response) => ({ status: "ready", items: siteStatItems(response?.data) }))
    .catch(() => ({ status: "unavailable", items: [] }));
  return cache.promise;
}

/** Test hook. */
export function resetSiteStatsCache() {
  cache.at = 0;
  cache.promise = null;
}

/** { status: "loading" | "ready" | "unavailable", items }; items is [] until loaded and on failure. */
export function useSiteStats() {
  const [state, setState] = useState({ status: "loading", items: [] });
  useEffect(() => {
    let active = true;
    fetchSiteStats().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);
  return state;
}

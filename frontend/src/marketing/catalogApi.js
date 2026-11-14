// Client for the public catalogue contract (HP\contracts\catalog.md §1, §3):
// GET /api/catalog/ → { gates, tracks, osint, tiers, untiered_pentesting,
// stats, plans, labs } and GET /api/labs/directory/ → { items, paths, me }.
// Every key is optional; a missing endpoint (404 before the backend ships) or
// a failed request yields an empty catalogue with status "unavailable" and the
// pages fall back to /api/courses/ + static copy. One request per minute at
// most (shared promise).
import { useEffect, useState } from "react";

import apiClient from "../api/client";
import { findCatalogTrack, TRACK_STATES } from "../utils/catalogTracks";
import { PENTESTING_REASON } from "./plans";

const TTL_MS = 60 * 1000;
const cache = new Map(); // url → { at, promise }

export const EMPTY_CATALOG = Object.freeze({
  status: "loading",
  gates: {},
  tracks: [],
  tiers: [],
  osintCourses: [],
  untiered: [],
  stats: {},
  plans: [],
  labs: null,
  freeChallenges: [],
});

export const EMPTY_DIRECTORY = Object.freeze({ status: "loading", items: [], paths: [], me: null });

function unwrap(body) {
  if (!body || typeof body !== "object") return {};
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data) && ("success" in body || "errors" in body)) return body.data;
  return body;
}

const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** Normalises the server payload (tolerant of absent keys). */
export function normalizeCatalog(body) {
  const data = unwrap(body);
  return {
    status: "ready",
    gates: asObject(data.gates),
    tracks: asArray(data.tracks),
    tiers: asArray(data.tiers).map((tier) => ({ ...tier, courses: asArray(tier.courses) })),
    osintCourses: asArray(data.osint?.courses),
    untiered: asArray(data.untiered_pentesting),
    stats: asObject(data.stats),
    plans: asArray(data.plans),
    labs: data.labs && typeof data.labs === "object" ? data.labs : null,
    freeChallenges: asArray(data.free_challenges || data.freeChallenges).filter((item) => item.title && item.url),
  };
}

export function normalizeDirectory(body) {
  const data = unwrap(body);
  return {
    status: "ready",
    items: asArray(data.items).filter((item) => item.title && item.url && /^https?:\/\//.test(String(item.url))),
    paths: asArray(data.paths),
    me: data.me && typeof data.me === "object" ? data.me : null,
  };
}

function cachedGet(url, normalize, empty, force) {
  const now = Date.now();
  const hit = cache.get(url);
  if (!force && hit && now - hit.at < TTL_MS) return hit.promise;
  const promise = apiClient
    .get(url)
    .then((response) => normalize(response?.data))
    .catch(() => ({ ...empty, status: "unavailable" }));
  cache.set(url, { at: now, promise });
  return promise;
}

export function fetchCatalog({ force = false } = {}) {
  return cachedGet("/catalog/", normalizeCatalog, EMPTY_CATALOG, force);
}

export function fetchDirectory({ force = false } = {}) {
  return cachedGet("/labs/directory/", normalizeDirectory, EMPTY_DIRECTORY, force);
}

/** Self-reported progress on a directory item (contract §3; auth). */
export async function markDirectoryDone(slug, { done = true, flag } = {}) {
  const response = await apiClient.post(`/labs/directory/${encodeURIComponent(slug)}/progress/`, flag ? { done, flag } : { done });
  cache.delete("/labs/directory/");
  return unwrap(response?.data);
}

/** Test hook. */
export function resetCatalogCache() {
  cache.clear();
}

function useCached(fetcher, empty) {
  const [value, setValue] = useState(empty);
  useEffect(() => {
    let active = true;
    fetcher().then((next) => {
      if (active) setValue(next);
    });
    return () => {
      active = false;
    };
  }, [fetcher]);
  return value;
}

export function useCatalog() {
  return useCached(fetchCatalog, EMPTY_CATALOG);
}

export function useDirectory() {
  return useCached(fetchDirectory, EMPTY_DIRECTORY);
}

/**
 * Is buying, enrolling in or applying for Pentesting allowed right now?
 * Order: the catalogue gate (server switch) → the track state from
 * /api/courses/ → unknown, which is treated as closed with the calm reason
 * (the server enforces the same rule with 403 feature_disabled).
 */
export function pentestingGate(catalog, tracks) {
  const gate = catalog?.gates?.pentesting;
  if (gate && typeof gate.enabled === "boolean") {
    return { enabled: gate.enabled, reason: gate.enabled ? "" : gate.reason || PENTESTING_REASON, known: true };
  }
  const track = findCatalogTrack(tracks, "web_pentesting");
  if (track && track.state === TRACK_STATES.OPEN && Number(track.open_course_count ?? 1) > 0) {
    return { enabled: true, reason: "", known: true };
  }
  return { enabled: false, reason: PENTESTING_REASON, known: Boolean(track) };
}

/** The labs switch: true only when the server says the labs are members-only. */
export function labsMembershipRequired(catalog) {
  const gate = catalog?.gates?.labs_membership_required;
  if (gate && gate.enabled === true) return true;
  return Boolean(catalog?.labs?.membership_required === true);
}

/**
 * The purchase gate of one course (contract CourseCard.purchase / course
 * payload purchase_gate). A Pentesting course is never purchasable while the
 * pentesting gate is closed, whatever else the payload says.
 */
export function coursePurchaseGate(course, gate) {
  const raw = course?.purchase_gate || course?.purchase || null;
  if (course?.category === "web_pentesting" && gate && !gate.enabled) {
    return { state: "coming_soon", code: "feature_disabled", reason: raw?.state && raw.state !== "available" && raw.reason ? raw.reason : gate.reason, disabled: true };
  }
  if (raw && raw.state && raw.state !== "available") {
    return { state: raw.state, code: raw.code || "", reason: raw.reason || "", disabled: true };
  }
  return { state: "available", code: "", reason: "", disabled: false };
}

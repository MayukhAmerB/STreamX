// The signed-in viewer's active Monthly CTF cosmetics (Golden Aura, podium
// frame, First Blood title) for the Console shell avatar. OWNER: WS-MONTHLY-CTF.
//
// Cheap by design: nothing is fetched unless the capabilities embedded in the
// signed-in user say `monthly_ctf` is on (no extra capabilities request, no
// 403 noise while it is off). One shared request per user, kept 10 minutes
// (the server caches the answer 60 s and computes it with one indexed query).
import { useEffect, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { fetchCosmetics } from "./seasonApi";
import { EMPTY_COSMETICS, monthlyCtfEnabled, normaliseCosmetics } from "./seasonModel";

export const COSMETICS_TTL_MS = 10 * 60 * 1000;

const cache = new Map(); // userId -> { at, value, promise }
const listeners = new Set();

function notify() {
  listeners.forEach((listener) => listener());
}

function load(userId) {
  const now = Date.now();
  const entry = cache.get(userId);
  if (entry && (entry.promise || now - entry.at < COSMETICS_TTL_MS)) return entry;
  const next = { at: now, value: entry?.value || EMPTY_COSMETICS, promise: null };
  next.promise = fetchCosmetics([userId])
    .then((data) => {
      next.value = normaliseCosmetics(data?.users?.[String(userId)]);
    })
    .catch(() => {
      // Off, signed out or offline: no cosmetics, never an error on screen.
      next.value = EMPTY_COSMETICS;
    })
    .finally(() => {
      next.promise = null;
      next.at = Date.now();
      notify();
    });
  cache.set(userId, next);
  return next;
}

/** Test helper. */
export function resetCosmeticsCache() {
  cache.clear();
}

/** Seeds the cache (e.g. from /ctf/seasons/me/ so the shell updates at once). */
export function primeCosmetics(userId, value) {
  if (userId == null) return;
  cache.set(userId, { at: Date.now(), value: normaliseCosmetics(value), promise: null });
  notify();
}

/** Active cosmetics of `user` when it is the signed-in viewer, else empty. */
export default function useMyCosmetics(user) {
  const auth = useAuth() || {};
  const me = auth.user || null;
  const caps = auth.capabilities || me?.capabilities || null;
  const userId = user?.id ?? null;
  const isMe = userId != null && me?.id === userId;
  const enabled = isMe && monthlyCtfEnabled(caps) === true;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    load(userId);
    return () => {
      listeners.delete(listener);
    };
  }, [enabled, userId]);

  if (!enabled) return EMPTY_COSMETICS;
  return cache.get(userId)?.value || EMPTY_COSMETICS;
}

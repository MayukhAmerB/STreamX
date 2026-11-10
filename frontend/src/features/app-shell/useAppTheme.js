import { useCallback, useState } from "react";
import {
  normalizeThemePreference,
  readStoredThemePreference,
  resolveCarbonTheme,
  writeStoredThemePreference,
} from "./theme";
import { useMediaQuery } from "./useBreakpoint";

function getLocalStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Light / dark / system preference for the app shell, remembered per browser. */
export function useAppTheme() {
  const [preference, setPreferenceState] = useState(() => readStoredThemePreference(getLocalStorage()));
  const systemPrefersDark = useMediaQuery("(prefers-color-scheme: dark)");

  const setPreference = useCallback((next) => {
    const normalized = normalizeThemePreference(next);
    setPreferenceState(normalized);
    writeStoredThemePreference(getLocalStorage(), normalized);
  }, []);

  return {
    preference,
    setPreference,
    carbonTheme: resolveCarbonTheme(preference, systemPrefersDark),
  };
}

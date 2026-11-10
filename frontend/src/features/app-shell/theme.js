// Theme preference for the functional app (Carbon White / G100).
export const THEME_PREFERENCES = ["light", "dark", "system"];
export const THEME_STORAGE_KEY = "alsyed.appTheme";
export const CARBON_THEMES = { light: "white", dark: "g100" };
// Carbon $background for each theme; used for <meta name="theme-color">.
export const THEME_BACKGROUNDS = { white: "#ffffff", g100: "#161616" };

export function normalizeThemePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : "system";
}

/** Resolves a stored preference + OS setting to a Carbon theme name. */
export function resolveCarbonTheme(preference, systemPrefersDark) {
  const normalized = normalizeThemePreference(preference);
  if (normalized === "system") {
    return systemPrefersDark ? CARBON_THEMES.dark : CARBON_THEMES.light;
  }
  return CARBON_THEMES[normalized];
}

export function readStoredThemePreference(storage) {
  try {
    return normalizeThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeStoredThemePreference(storage, preference) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalizeThemePreference(preference));
  } catch {
    // Private mode / blocked storage: the choice simply is not remembered.
  }
}

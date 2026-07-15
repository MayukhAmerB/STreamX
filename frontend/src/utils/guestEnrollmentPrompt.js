const GUEST_ENROLLMENT_PROMPT_SESSION_KEY = "asi:guest-enrollment-prompt-shown:v2";

export function reserveGuestEnrollmentPrompt({
  authLoading,
  isAuthenticated,
  hasScrolledPastHero,
  isKnownRegistered,
  getStorage,
}) {
  if (authLoading || isAuthenticated || !hasScrolledPastHero || isKnownRegistered) return false;

  try {
    const storage = getStorage();
    if (storage.getItem(GUEST_ENROLLMENT_PROMPT_SESSION_KEY)) return false;
    storage.setItem(GUEST_ENROLLMENT_PROMPT_SESSION_KEY, "1");
  } catch {
    // The prompt should still work when browser storage is unavailable.
  }

  return true;
}

export function hasReachedGuestPromptScrollPoint({ heroBottom, viewportHeight }) {
  const safeHeroBottom = Number(heroBottom);
  const safeViewportHeight = Number(viewportHeight);
  if (!Number.isFinite(safeHeroBottom) || !Number.isFinite(safeViewportHeight)) return false;
  return safeHeroBottom <= safeViewportHeight * 0.45;
}

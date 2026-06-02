export const LANDING_PUBLIC_ENROLLMENT_PROMPT_EVENT = "asi:landing-public-enrollment-prompt";

export function requestLandingPublicEnrollmentPrompt(target = { type: "general" }) {
  window.dispatchEvent(
    new CustomEvent(LANDING_PUBLIC_ENROLLMENT_PROMPT_EVENT, {
      detail: target,
    })
  );
}

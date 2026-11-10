import { Logout } from "@carbon/icons-react";

export default function SignOutButton({ onSignOut }) {
  return (
    <button
      type="button"
      className="cds-app-action-list__item cds-app-action-list__item--danger"
      onClick={onSignOut}
    >
      <Logout size={20} aria-hidden="true" />
      <span>Sign out</span>
    </button>
  );
}

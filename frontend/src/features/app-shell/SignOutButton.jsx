import { Logout } from "@carbon/icons-react";

export default function SignOutButton({ onSignOut }) {
  return (
    <button type="button" className="cds-app-nav-row cds-app-nav-row--quiet" onClick={onSignOut}>
      <Logout size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
      <span className="cds-app-nav-row__label">Sign out</span>
    </button>
  );
}

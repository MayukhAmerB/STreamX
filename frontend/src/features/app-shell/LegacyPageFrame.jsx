import { siteBrand } from "../../config/siteBrand";

/**
 * Renders a not-yet-migrated page inside the shell with the website's own
 * look (dark, or OwlCognito light), so its Tailwind styles keep working and
 * Carbon's scoped reset does not touch it. Removed per page in phases 3-4.
 */
export default function LegacyPageFrame({ children }) {
  const brandClass = siteBrand.id === "owlcognito" ? " owlcognito-app-shell" : "";
  return <div className={`cds-legacy-frame${brandClass}`}>{children}</div>;
}

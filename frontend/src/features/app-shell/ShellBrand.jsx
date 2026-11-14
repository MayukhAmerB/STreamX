import OwlCognitoMark from "../../components/OwlCognitoMark";
import { siteBrand } from "../../config/siteBrand";

/**
 * Brand block of the Console header (plan §3.1): the 24 px mark and the
 * brand name. No platform label and no "Console" eyebrow: the workspace and
 * page are named by the breadcrumb.
 */
export default function ShellBrand() {
  const isOwlCognito = siteBrand.id === "owlcognito";
  return (
    <span className="cds-app-brand">
      <span className={`cds-app-brand__mark${isOwlCognito ? " cds-app-brand__mark--owl" : ""}`} aria-hidden="true">
        {isOwlCognito ? <OwlCognitoMark className="cds-app-brand__owl" /> : <img src="/logo.jpeg" alt="" decoding="async" />}
      </span>
      <span className="cds-app-brand__name">{siteBrand.name}</span>
    </span>
  );
}

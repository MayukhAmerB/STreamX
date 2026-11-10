import OwlCognitoMark from "../../components/OwlCognitoMark";
import { siteBrand } from "../../config/siteBrand";
import { USERS_CORNER_TITLE } from "./navConfig";

/**
 * The website navbar's brand block (same logo asset / OwlCognito mark, name
 * and uppercase platform label), restyled for the black shell header. On
 * phones the platform label gives way to "User's Corner".
 */
export default function ShellBrand() {
  const isOwlCognito = siteBrand.id === "owlcognito";
  return (
    <span className="uc-brand">
      <span className={`uc-brand__mark${isOwlCognito ? " uc-brand__mark--owl" : ""}`} aria-hidden="true">
        {isOwlCognito ? (
          <OwlCognitoMark className="uc-brand__owl" />
        ) : (
          <img src="/logo.jpeg" alt="" decoding="async" />
        )}
      </span>
      <span className="uc-brand__text">
        <span className="uc-brand__name">{siteBrand.name}</span>
        <span className="uc-brand__platform">{siteBrand.platformLabel}</span>
        <span className="uc-brand__corner">{USERS_CORNER_TITLE}</span>
      </span>
    </span>
  );
}

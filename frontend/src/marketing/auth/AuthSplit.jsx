import { Link } from "react-router-dom";

import OwlCognitoMark from "../../components/OwlCognitoMark";
import { siteBrand } from "../../config/siteBrand";
import "./auth.css";

/** Credit line under the art (ours, never theirs). */
export function authCredit() {
  return siteBrand.id === "owlcognito" ? "Built and taught by the OwlCognito team." : "Built and taught by Al Syed Initiative.";
}

function BrandMark() {
  if (siteBrand.id === "owlcognito") {
    return <OwlCognitoMark className="au-art__mark au-art__mark--owl" />;
  }
  return <img className="au-art__mark" src="/logo-256.webp" alt="" width="88" height="88" decoding="async" />;
}

/**
 * Left half of the split screen (lg and up): four hairlines (two axes, two
 * 520 px diagonals) crossing at the centre, where a black square holds our
 * mark. Decorative: the lines and the mark are aria-hidden; the brand link
 * and the credit are real text.
 */
export function AuthArt({ credit = authCredit() }) {
  return (
    <div className="au-art">
      <span className="au-art__line au-art__line--h" aria-hidden="true" />
      <span className="au-art__line au-art__line--v" aria-hidden="true" />
      <span className="au-art__line au-art__line--d1" aria-hidden="true" />
      <span className="au-art__line au-art__line--d2" aria-hidden="true" />
      <span className="au-art__hub" aria-hidden="true">
        <BrandMark />
      </span>
      <Link to="/" className="au-art__brand">
        {siteBrand.name}
      </Link>
      {credit ? <p className="au-art__credit">{credit}</p> : null}
    </div>
  );
}

/**
 * T-AUTH split screen (PHILOSOPHY §2.7 "Sign-in", T6): radial line art on the
 * left (lg+), a #0a0a0a rounded panel on the right with a corner link, the
 * page content and an optional foot. Below lg only the panel shows, with the
 * brand top-left.
 *
 * - corner: node for the top-right slot (e.g. a "Browse courses" link)
 * - long: tighter top margin for long forms (registration)
 * - labelledBy: id of the page headline (the panel is a labelled region)
 */
export default function AuthSplit({ corner = null, long = false, labelledBy, credit, foot = null, children }) {
  return (
    <div className="au-page">
      <div className="au-split">
        <AuthArt credit={credit} />
        <section className={`au-panel${long ? " au-panel--long" : ""}`} aria-labelledby={labelledBy}>
          <div className="au-panel__top">
            <Link to="/" className="au-panel__brand">
              {siteBrand.name}
            </Link>
            {corner}
          </div>
          <div className="au-panel__body">{children}</div>
          {foot ? <div className="au-panel__foot">{foot}</div> : null}
        </section>
      </div>
    </div>
  );
}

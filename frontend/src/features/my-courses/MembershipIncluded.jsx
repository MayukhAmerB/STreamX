// "Included this month" on My courses. OWNER: WS-LEARN.
// Renders nothing unless the viewer has an active OSINT plan (CTF Labs
// membership or Starter). The data hook only runs while the `memberships`
// switch is on, so production today makes no extra request.
import { ArrowRight } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchCatalog, fetchLabsEntitlement } from "../../api/catalog";
import { fetchMySubscriptions } from "../../api/plans";
import { buildMembershipLibrary } from "./membershipLibrary";

/** Fetches entitlement + subscriptions + catalogue once, only when `enabled`. */
export function useMembershipLibrary(enabled, ownedIds = []) {
  const [raw, setRaw] = useState(null);
  useEffect(() => {
    if (!enabled) {
      setRaw(null);
      return undefined;
    }
    let active = true;
    Promise.allSettled([fetchLabsEntitlement(), fetchMySubscriptions(), fetchCatalog()]).then(([entitlement, subscriptions, catalog]) => {
      if (!active) return;
      setRaw({
        entitlement: entitlement.status === "fulfilled" ? entitlement.value : null,
        subscriptions: subscriptions.status === "fulfilled" ? subscriptions.value : null,
        catalog: catalog.status === "fulfilled" ? catalog.value : null,
      });
    });
    return () => {
      active = false;
    };
  }, [enabled]);
  if (!raw) return null;
  return buildMembershipLibrary({ ...raw, ownedIds });
}

/** Presentational: a hairline list of the recordings an OSINT plan includes. */
export function MembershipIncludedSection({ library }) {
  if (!library?.active) return null;
  const { courses = [], monthLabel = "", labsActive } = library;
  const eyebrow = labsActive ? `Included this month${monthLabel ? ` · ${monthLabel}` : ""}` : "Included with Starter";
  return (
    <section className="mc-included" aria-labelledby="mc-included-title" data-testid="membership-included">
      <div className="mc-included__head">
        <p className="mc-included__eyebrow">{eyebrow}</p>
        <h2 id="mc-included-title" className="mc-included__title">
          With your membership
        </h2>
        <p className="mc-included__lead">
          Recorded classes you can watch while your plan is active. Live classes, reports, exams and certificates stay with
          enrolment.
        </p>
      </div>
      {courses.length ? (
        <ul className="mc-included__list">
          {courses.map((course) => (
            <li key={course.id}>
              <Link className="mc-included__row" to={`/learn/${course.id}`}>
                <span className="mc-included__name">{course.title}</span>
                <span className="mc-included__chip">{course.label}</span>
                <ArrowRight size={16} aria-hidden="true" className="mc-included__arrow" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mc-included__empty">This month&apos;s recordings are being chosen. Check back soon.</p>
      )}
    </section>
  );
}

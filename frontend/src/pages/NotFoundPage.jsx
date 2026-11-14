// Unknown website address (PHILOSOPHY T-TRACK small hero): a real "not found"
// page, kept out of search via the page meta, with two calls to action and
// the most useful pages.
import { Link as RouterLink } from "react-router-dom";

import { ArrowRightIcon, ButtonLink, Hand, Tagline } from "../marketing/primitives";

const NEXT_STEPS = [
  { to: "/courses", title: "Courses", body: "Open cohorts and the Pentesting tiers." },
  { to: "/roadmap", title: "Roadmap", body: "What is open now and what opens next." },
  { to: "/about", title: "About us", body: "Who we are and how the training works." },
  { to: "/contact", title: "Contact", body: "Ask the team about enrolment or access." },
];

export default function NotFoundPage() {
  return (
    <div className="hp-not-found" data-page="not-found">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-not-found-title">
        <Tagline>Page not found · 404</Tagline>
        <h1 id="hp-not-found-title" className="hp-display">
          <span className="hp-display__line">
            Lost the <Hand>trail</Hand>.
          </span>
        </h1>
        <p className="hp-lead">This page could not be found. The link may be old or mistyped; everything on the site is still a click away.</p>
        <div className="hp-actions">
          <ButtonLink to="/" variant="primary" size="lg" arrow>
            Go to the home page
          </ButtonLink>
          <ButtonLink to="/courses" variant="secondary" size="lg">
            Browse courses
          </ButtonLink>
        </div>
      </section>
      <div className="hp-frame" style={{ paddingBottom: 64 }}>
        <ul className="hp-grid hp-grid--4" aria-label="Popular pages">
          {NEXT_STEPS.map((step) => (
            <li key={step.to}>
              <RouterLink className="hp-card hp-card--link hp-link-tile" to={step.to}>
                <span className="hp-card__title">{step.title}</span>
                <span className="hp-card__desc">{step.body}</span>
                <ArrowRightIcon className="hp-btn__arrow" />
              </RouterLink>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

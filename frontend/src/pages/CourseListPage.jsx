// /courses (PHILOSOPHY T3 "courses-full", BUILD_PLAN §2.1): hero with one
// handwritten word, stat strip, the Pentesting notice, filter chips that wrap,
// tier sections of hairline-grid catalogue cards, then the pricing band.
// Data source unchanged: GET /api/courses/?catalog=current (+ the cached copy)
// and the public catalogue contract for gates, plans and stats.
// URLs kept: ?category=osint|web_pentesting (#course-category-results),
// ?view=live (and /live-classes, which redirects here); ?view=owned redirects
// to /my-courses in AppRoutes.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { EmptyState } from "../site-kit";
import { FREE_TIER, labAccess, LABS, labUrl } from "../data/freeLabs";
import { useAuth } from "../hooks/useAuth";
import { labsMembershipRequired } from "../marketing/catalogApi";
import { CardShell, CourseCatalogCard, LabCatalogCard, TierSection } from "../marketing/CatalogCard";
import { CATALOGUE } from "../marketing/marketingContent";
import PricingBand from "../marketing/PricingBand";
import { ButtonLink, Hand, Notice, StatStrip, StatusPill, Tagline } from "../marketing/primitives";
import { PENTESTING_TIERS } from "../marketing/tiers";
import { useMarketingData } from "../marketing/useMarketingData";
import { findCatalogTrack, TRACK_COMING_SOON_REASON, TRACK_STATES } from "../utils/catalogTracks";
import { hasApprovedCourseAccess } from "../utils/courseAccess";
import { filterCourseCatalog, getCourseCategoryPath } from "../utils/courseCatalog";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import LiveClassesBand from "./landing/LiveClassesBand";
import { useLandingLiveClasses } from "./landing/useLandingData";
import "./landing/landing.css";

const COURSE_CATEGORY_LABELS = {
  osint: "OSINT",
  web_pentesting: "Pentesting",
};

export function resolveCourseCategory(value) {
  return Object.hasOwn(COURSE_CATEGORY_LABELS, String(value || "")) ? String(value) : "osint";
}

export function getCourseCatalogSummary(courses) {
  return {
    live: courses.filter((course) => getCourseLaunchStatus(course).isLive).length,
    comingSoon: courses.filter((course) => getCourseLaunchStatus(course).isComingSoon).length,
    osint: courses.filter((course) => course.category === "osint").length,
    web: courses.filter((course) => course.category === "web_pentesting").length,
  };
}

export function getCourseLevelSummary(courses) {
  return courses.reduce(
    (acc, course) => {
      const level = course?.level || "other";
      if (acc[level] !== undefined) acc[level] += 1;
      return acc;
    },
    { beginner: 0, intermediate: 0, advanced: 0, other: 0 },
  );
}

export { hasApprovedCourseAccess };

/**
 * A track the server reports as not open AND with nothing to browse gets one
 * calm empty state (plan §7.2 rule 3), with one real action: the first open
 * track, else Contact.
 */
export function getTrackEmptyState(tracks, category) {
  const track = findCatalogTrack(tracks, category);
  if (!track || track.state === TRACK_STATES.OPEN) return null;
  const label = COURSE_CATEGORY_LABELS[category] || track.title || "This track";
  const openTrack = Object.keys(COURSE_CATEGORY_LABELS)
    .map((key) => findCatalogTrack(tracks, key))
    .find((item) => item && item.state === TRACK_STATES.OPEN);
  const action = openTrack
    ? { label: `View ${COURSE_CATEGORY_LABELS[openTrack.key] || openTrack.title} courses`, href: getCourseCategoryPath(openTrack.key) }
    : { label: "Contact us", href: "/contact" };
  return (
    <div data-theme="g100" className="course-track-empty">
      <EmptyState headingLevel={3} title={`${label} opens soon`} body={`${TRACK_COMING_SOON_REASON}.`} action={action} />
    </div>
  );
}

/** The filter chips (they wrap at 390, PHILOSOPHY T3). `key` → URL. */
export const CATALOG_FILTERS = [
  { key: "all", label: "All", to: "/courses" },
  { key: "free", label: "Free", to: "/courses?filter=free#course-category-results" },
  { key: "osint", label: "OSINT", to: getCourseCategoryPath("osint") },
  { key: "live", label: "Live classes", to: "/courses?view=live#course-category-results" },
  { key: "web_pentesting", label: "Pentesting", to: getCourseCategoryPath("web_pentesting") },
  ...PENTESTING_TIERS.map((tier) => ({ key: tier.key, label: tier.key === "quick_wins" ? tier.label : tier.label.replace(/ security| operations/, ""), to: `/courses?tier=${tier.key}#course-category-results` })),
];

/** Which filter the URL selects. */
export function resolveCatalogFilter(searchParams) {
  if (searchParams.get("view") === "live") return "live";
  const tier = searchParams.get("tier");
  if (tier && PENTESTING_TIERS.some((item) => item.key === tier)) return tier;
  if (searchParams.get("filter") === "free") return "free";
  const category = searchParams.get("category");
  if (category === "osint" || category === "web_pentesting") return category;
  return "all";
}

function useStickyCta(sentinelRef) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof window === "undefined" || typeof window.IntersectionObserver !== "function") return undefined;
    const observer = new window.IntersectionObserver(([entry]) => setShown(!entry.isIntersecting && entry.boundingClientRect.top < 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [sentinelRef]);
  return shown;
}

function FreeSection({ membersOnly }) {
  return (
    <TierSection
      id="tier-free"
      kicker={CATALOGUE.freeSection.kicker}
      title={CATALOGUE.freeSection.title}
      summary={CATALOGUE.freeSection.summary}
      count={LABS.length + 1}
      countLabel="item"
    >
      <li>
        <CardShell
          href={FREE_TIER.href}
          title="Free OSINT challenges"
          label="Free OSINT challenges. Free. Start free"
          eyebrow="Beginner to advanced · link-out"
          status={<StatusPill kind="free">Free</StatusPill>}
          art="flag"
          description={FREE_TIER.summary}
          facts="No card required"
          action="Start free"
        />
      </li>
      {LABS.map((lab) => (
        <li key={lab.id}>
          <LabCatalogCard lab={lab} access={labAccess(lab, { membershipRequired: membersOnly })} href={labUrl(lab.tab)} />
        </li>
      ))}
    </TierSection>
  );
}

/** ?view=live: the live classes (fetched only in this view). */
function LiveView({ isAuthenticated }) {
  const liveClasses = useLandingLiveClasses(isAuthenticated);
  return (
    <section aria-label="Live classes" className="hp-rule-top">
      <LiveClassesBand theme="g100" liveClasses={liveClasses} />
    </section>
  );
}

export default function CourseListPage() {
  const [searchParams] = useSearchParams();
  const { isAuthenticated } = useAuth() || {};
  const data = useMarketingData();
  const { courses: feed, catalog, gate, tiers, osint, stats } = data;
  const [search, setSearch] = useState("");
  const filter = resolveCatalogFilter(searchParams);
  const heroRef = useRef(null);
  const stickyShown = useStickyCta(heroRef);
  const membersOnly = labsMembershipRequired(catalog);

  useEffect(() => {
    if (window.location.hash !== "#course-category-results") return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("course-category-results")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filter]);

  const term = search.trim();
  const matches = useMemo(() => new Set(filterCourseCatalog(feed.courses, term).map((course) => course.id)), [feed.courses, term]);
  const visible = (list) => (term ? list.filter((course) => matches.has(course.id)) : list);

  const osintVisible = visible(osint);
  const tierGroups = tiers.map((tier) => ({ ...tier, courses: visible(tier.courses) })).filter((tier) => tier.courses.length);
  const showFree = !term && (filter === "all" || filter === "free");
  const showOsint = filter === "all" || filter === "osint";
  const showLive = filter === "live";
  const showPentesting = filter === "all" || filter === "web_pentesting" || PENTESTING_TIERS.some((tier) => tier.key === filter);
  const pentestingGroups = PENTESTING_TIERS.some((tier) => tier.key === filter) ? tierGroups.filter((tier) => tier.key === filter) : tierGroups;
  const pentestingTotal = tiers.reduce((sum, tier) => sum + tier.courses.length, 0);
  const loading = feed.status === "loading" && !feed.courses.length;
  const nothing = !loading && term && !osintVisible.length && !tierGroups.length;

  const strip = [
    { label: "Courses", value: stats.courses || null },
    { label: "Modules", value: stats.modules || null },
    { label: "Free challenges", value: stats.freeChallenges || "Free" },
    { label: "Live cohorts", value: stats.liveCohorts || null },
  ];

  return (
    <div className="lp lp--hp" data-page="catalogue">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-courses-title" ref={heroRef}>
        <Tagline>{CATALOGUE.tagline}</Tagline>
        <h1 id="hp-courses-title" className="hp-display hp-display--xl">
          <span className="hp-display__line">{CATALOGUE.line1}</span>{" "}
          <span className="hp-display__line">
            {CATALOGUE.line2Before} <Hand>{CATALOGUE.accent}</Hand>.
          </span>
        </h1>
        <p className="hp-lead">{CATALOGUE.lead}</p>
        <div className="hp-actions">
          <ButtonLink to={FREE_TIER.href} variant="primary" size="lg" arrow>
            {CATALOGUE.primaryCta}
          </ButtonLink>
          <ButtonLink to="/pricing" variant="secondary" size="lg">
            {CATALOGUE.secondaryCta}
          </ButtonLink>
        </div>
        <StatStrip items={strip} label="The catalogue in numbers" />
        <svg className="hp-scroll-cue" viewBox="0 0 20 28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <rect x="1.5" y="1.5" width="17" height="25" rx="8.5" />
          <path d="M10 7v5" />
        </svg>
      </section>

      <section className="hp-band hp-band--tight-top" aria-label="Catalogue">
        <div className="hp-frame">
          {gate.enabled ? null : (
            <Notice eyebrow={CATALOGUE.pentestingNotice.eyebrow} title={CATALOGUE.pentestingNotice.title} icon="clock">
              {CATALOGUE.pentestingNotice.body}
            </Notice>
          )}

          <div id="course-category-results" className="hp-catalog-tools">
            <nav aria-label="Filter courses">
              <ul className="hp-chips">
                {CATALOG_FILTERS.map((item) => (
                  <li key={item.key}>
                    <Link className="hp-chip" to={item.to} aria-current={filter === item.key ? "page" : undefined}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <label className="hp-search">
              <span className="hp-sr">Search courses</span>
              <input type="search" className="hp-underline-field" placeholder="Search courses…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>

          {feed.status === "error" ? (
            <p className="hp-reason" role="status" style={{ marginTop: 24 }}>
              {feed.courses.length ? "Showing the last saved course list. Live refresh failed." : "The course list is temporarily unavailable. Please try again."}{" "}
              <button type="button" className="hp-text-link" onClick={feed.retry}>
                Retry
              </button>
            </p>
          ) : null}
          {loading ? (
            <p className="hp-body" aria-busy="true" style={{ marginTop: 40 }}>
              Loading the catalogue…
            </p>
          ) : null}
          {nothing ? (
            <p className="hp-body" style={{ marginTop: 40 }}>
              No courses found.
            </p>
          ) : null}

          <div className="hp-tiers">
            {showFree ? <FreeSection membersOnly={membersOnly} /> : null}

            {showOsint && osintVisible.length ? (
              <TierSection id="tier-osint" kicker={CATALOGUE.osintSection.kicker} title={CATALOGUE.osintSection.title} summary={CATALOGUE.osintSection.summary} count={osintVisible.length}>
                {osintVisible.map((course) => (
                  <li key={course.id}>
                    <CourseCatalogCard course={course} />
                  </li>
                ))}
              </TierSection>
            ) : null}

            {showPentesting && !loading
              ? pentestingTotal
                ? pentestingGroups.map((tier) => (
                    <TierSection
                      key={tier.key}
                      id={`tier-${tier.key}`}
                      kicker={`Pentesting · ${gate.enabled ? "Open" : "Coming soon"}`}
                      title={tier.label}
                      summary={tier.summary}
                      count={tier.courses.length}
                    >
                      {tier.courses.map((course) => (
                        <li key={course.id}>
                          <CourseCatalogCard course={course} />
                        </li>
                      ))}
                    </TierSection>
                  ))
                : !term
                  ? (
                      <section className="hp-tier" aria-labelledby="tier-pentesting-title" data-track-state="coming_soon">
                        <div className="hp-tier__head">
                          <div>
                            <p className="hp-eyebrow hp-tier__kicker">Pentesting</p>
                            <h3 id="tier-pentesting-title" className="hp-tier__title">
                              Pentesting
                            </h3>
                            <p className="hp-tier__summary">{TRACK_COMING_SOON_REASON}</p>
                          </div>
                          <Link className="hp-text-link" to="/tracks/pentesting">
                            About the track →
                          </Link>
                        </div>
                        {getTrackEmptyState(feed.tracks, "web_pentesting")}
                      </section>
                    )
                  : null
              : null}
          </div>
        </div>
      </section>

      {showLive ? <LiveView isAuthenticated={isAuthenticated} /> : null}

      <PricingBand id="catalogue-pricing" />

      <div className="hp-sticky-cta" data-shown={stickyShown ? "true" : "false"} aria-hidden={stickyShown ? undefined : "true"}>
        <ButtonLink to={FREE_TIER.href} variant="primary" arrow tabIndex={stickyShown ? undefined : -1}>
          Start free
        </ButtonLink>
      </div>
    </div>
  );
}

// /hall-of-fame: the grand Hall of Fame (HackPath design language, palette law:
// black, greys, whites, one golden white with a soft glow).
//
// Data: GET /api/certification/hall-of-fame/ (apps.certification). Students who
// pass the certification exam are added automatically; curated entries are
// merged in by staff. Owner rule: every card shows the student's HANDLE only
// (never the real name), links to their public profile when it is public, and
// to the verified certificate page (/certificates/<reference>), which is
// where the real name appears.
//
// Layout: a monumental hero (one handwritten accent word, golden light),
// counters (real numbers only), large hero cards for the most recent and the
// top graduates, then the wall of honour grouped by batch/year with big
// handles, paginated ("Show more"). Motion: CSS-only glow plus the kit
// <Reveal> for below-the-fold cards; reduced motion shows the final state.
import "./HallOfFamePage.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { fetchHallOfFame } from "../features/certification/certificationApi";
import { Reveal } from "../kit/motion";
import { ArrowRightIcon, ButtonLink, Hand, Tagline, cx } from "../marketing/primitives";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function formatAchievedOn(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : DATE.format(date);
}

/** Group loaded entries by batch (or year), keeping the server's order. */
export function groupEntries(entries = []) {
  const groups = [];
  const index = new Map();
  for (const entry of entries) {
    const key = entry.group || entry.batch || "Graduates";
    if (!index.has(key)) {
      index.set(key, { key, entries: [] });
      groups.push(index.get(key));
    }
    index.get(key).entries.push(entry);
  }
  return groups;
}

/** Counters with real numbers only: zero or missing figures are left out. */
export function counterItems(counters = {}) {
  return [
    { key: "graduates", label: "Certified graduates", value: counters.graduates },
    { key: "batches", label: counters.batches === 1 ? "Batch" : "Batches", value: counters.batches },
    { key: "verified", label: "Verified certificates", value: counters.verified_certificates },
    { key: "since", label: "Honoured since", value: counters.since },
  ].filter((item) => Number.isFinite(item.value) && item.value > 0);
}

const groupId = (key) => `hof-group-${String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

function Handle({ entry, className }) {
  const label = `@${entry.handle}`;
  if (entry.profile_url) {
    return (
      <Link to={entry.profile_url} className={cx(className, "hof-handle-link")}>
        {label}
      </Link>
    );
  }
  return <span className={className}>{label}</span>;
}

function CertificateLink({ entry, className }) {
  if (!entry.certificate_url) return null;
  return (
    <Link to={entry.certificate_url} className={cx("hof-cert-link", className)}>
      View certificate
      <span className="hp-sr"> of @{entry.handle}</span>
      <ArrowRightIcon className="hof-cert-link__arrow" />
    </Link>
  );
}

function Meta({ entry }) {
  const parts = [entry.batch, formatAchievedOn(entry.achieved_on)].filter(Boolean);
  return parts.length ? <p className="hof-meta hp-mono">{parts.join(" · ")}</p> : null;
}

export function FeaturedCard({ entry, kind, index = 0 }) {
  return (
    <Reveal as="li" index={index} className="hof-feature" data-kind={kind}>
      <article className="hof-feature__card" aria-label={`@${entry.handle}`}>
        <p className="hof-feature__kicker">
          <span className="hof-feature__rank hp-mono" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          {kind === "top" && entry.band ? entry.band : entry.achievement}
        </p>
        <h3 className="hof-feature__handle">
          <Handle entry={entry} />
        </h3>
        <Meta entry={entry} />
        {kind === "top" ? <p className="hof-feature__achievement">{entry.achievement}</p> : null}
        <CertificateLink entry={entry} />
      </article>
    </Reveal>
  );
}

export function WallTile({ entry, index = 0 }) {
  return (
    <Reveal as="li" index={index} className="hof-tile">
      <Handle entry={entry} className="hof-tile__handle" />
      <p className="hof-tile__achievement">{entry.achievement}</p>
      <Meta entry={entry} />
      <CertificateLink entry={entry} className="hof-tile__cert" />
    </Reveal>
  );
}

/** Presentational page (tests render it with fixed data). */
export function HallOfFameView({ data, status = "ready", batch = "", loadingMore = false, onBatch, onMore, onRetry }) {
  const counters = counterItems(data?.counters);
  const recent = data?.featured?.recent || [];
  const recentIds = new Set(recent.map((entry) => entry.id));
  // With few graduates the top list repeats the recent one: show it only when it adds someone.
  const top = (data?.featured?.top || []).some((entry) => !recentIds.has(entry.id)) ? data.featured.top : [];
  const groups = useMemo(() => groupEntries(data?.entries || []), [data?.entries]);
  const batches = data?.batches || [];
  const empty = status === "ready" && !(data?.entries || []).length && !batch;

  return (
    <div data-page="hall-of-fame" className="hof">
      <section className="hof-hero" aria-labelledby="hof-title">
        <div className="hof-hero__light" aria-hidden="true" />
        <Tagline>Earned, not given</Tagline>
        <h1 id="hof-title" className="hof-hero__title">
          <span className="hof-hero__line">The Hall</span> <span className="hof-hero__line">
            of <Hand accent>Fame</Hand>
          </span>
        </h1>
        <p className="hof-hero__lead">
          A permanent record of the investigators who met the Al Syed certification standard through skill, discipline and
          careful method. Every name here links to a certificate anyone can verify.
        </p>
        {counters.length ? (
          <dl className="hof-counters" aria-label="Hall of Fame in numbers" style={{ "--hof-counters": counters.length }}>
            {counters.map((item) => (
              <div key={item.key} className="hof-counter">
                <dt>{item.label}</dt>
                <dd className="hp-mono">{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

      <div className="hp-frame hof-body">
        {status === "loading" ? (
          <p className="hof-state" role="status">
            Opening the Hall of Fame…
          </p>
        ) : null}
        {status === "error" ? (
          <div className="hof-state hof-state--error" role="alert">
            <p>The Hall of Fame could not be loaded just now.</p>
            <button type="button" className="hp-btn hp-btn--secondary" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}
        {empty ? (
          <div className="hof-state">
            <p className="hof-state__title">The first names are being engraved.</p>
            <p>Graduates appear here as soon as they pass the certification exam.</p>
          </div>
        ) : null}

        {recent.length && !batch ? (
          <section className="hof-section" aria-labelledby="hof-recent">
            <header className="hof-section__head">
              <p className="hof-eyebrow">Newest honours</p>
              <h2 id="hof-recent" className="hof-section__title">
                Most recent graduates
              </h2>
            </header>
            <ol className="hof-features">
              {recent.map((entry, index) => (
                <FeaturedCard key={`recent-${entry.id}`} entry={entry} kind="recent" index={index} />
              ))}
            </ol>
          </section>
        ) : null}

        {top.length && !batch ? (
          <section className="hof-section" aria-labelledby="hof-top">
            <header className="hof-section__head">
              <p className="hof-eyebrow">Highest results</p>
              <h2 id="hof-top" className="hof-section__title">
                Top graduates
              </h2>
            </header>
            <ol className="hof-features hof-features--top">
              {top.map((entry, index) => (
                <FeaturedCard key={`top-${entry.id}`} entry={entry} kind="top" index={index} />
              ))}
            </ol>
          </section>
        ) : null}

        {status === "ready" && (groups.length || batch) ? (
          <section className="hof-section hof-wall" aria-labelledby="hof-wall">
            <header className="hof-section__head hof-wall__head">
              <div>
                <p className="hof-eyebrow">Wall of honour</p>
                <h2 id="hof-wall" className="hof-section__title">
                  Every certified graduate
                </h2>
              </div>
              {batches.length > 1 ? (
                <div className="hof-filter" role="group" aria-label="Show a batch">
                  <button type="button" className="hof-chip" aria-pressed={!batch} onClick={() => onBatch?.("")}>
                    All
                  </button>
                  {batches.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="hof-chip"
                      aria-pressed={batch === item.label}
                      onClick={() => onBatch?.(item.label)}
                    >
                      {item.label}
                      <span className="hof-chip__count hp-mono">{item.count}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </header>
            {groups.map((group) => {
              const total = batches.find((item) => item.label === group.key)?.count ?? group.entries.length;
              return (
                <section key={group.key} className="hof-group" aria-labelledby={groupId(group.key)}>
                  <div className="hof-group__head">
                    <h3 id={groupId(group.key)} className="hof-group__title">
                      {group.key}
                    </h3>
                    <p className="hof-group__count hp-mono">
                      {total} certified
                    </p>
                  </div>
                  <ol className="hof-wall__grid">
                    {group.entries.map((entry, index) => (
                      <WallTile key={entry.id} entry={entry} index={index} />
                    ))}
                  </ol>
                </section>
              );
            })}
            {data?.has_more ? (
              <div className="hof-more">
                <button type="button" className="hp-btn hp-btn--secondary" onClick={onMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Show more graduates"}
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="hof-close">
          <p className="hof-close__line">
            Earned through knowledge. <Hand>Remembered</Hand> through excellence.
          </p>
          <ButtonLink to="/tracks/osint" variant="secondary" arrow>
            Work towards the certificate
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}

export default function HallOfFamePage() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading");
  const [batch, setBatch] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (nextBatch = "") => {
    const id = ++request.current;
    setStatus("loading");
    try {
      const result = await fetchHallOfFame({ page: 1, batch: nextBatch });
      if (id !== request.current) return;
      setData((previous) => (nextBatch && previous ? { ...result, featured: previous.featured, counters: previous.counters } : result));
      setStatus("ready");
    } catch {
      if (id === request.current) setStatus("error");
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  const onBatch = (value) => {
    setBatch(value);
    load(value);
  };

  const onMore = async () => {
    if (!data?.has_more || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchHallOfFame({ page: (data.page || 1) + 1, batch });
      setData((previous) => ({ ...previous, ...next, featured: previous.featured, counters: previous.counters,
        entries: [...(previous?.entries || []), ...(next?.entries || [])] }));
    } catch {
      // Keep what is shown; the button stays for another try.
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <HallOfFameView
      data={data}
      status={status}
      batch={batch}
      loadingMore={loadingMore}
      onBatch={onBatch}
      onMore={onMore}
      onRetry={() => load(batch)}
    />
  );
}

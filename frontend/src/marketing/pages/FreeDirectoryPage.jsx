// /osint/free (owner OSINT rules: the FREE tier). A curated directory of free,
// server-less OSINT challenges hosted by other platforms: we keep only the
// metadata and LINK OUT ("Start on <platform>"), never their text, images or
// answers. Our own learning path and self-reported progress (signed-in) sit
// on top. Data: GET /api/labs/directory/ (HP\contracts\catalog.md §3).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { markDirectoryDone, useDirectory } from "../catalogApi";
import {
  ArrowUpRightIcon,
  ButtonLink,
  CheckCircleIcon,
  Eyebrow,
  FaqList,
  Hand,
  Notice,
  OpenCircleIcon,
  StatStrip,
  Tagline,
} from "../primitives";

const DIFFICULTY_LABELS = { easy: "Easy", medium: "Medium", hard: "Hard" };

export const FREE_FAQ = [
  {
    q: "Why do the challenges open on other sites?",
    a: "They belong to the platforms that made them. We list them, explain where each fits in the path and link you straight to the source. We never copy their text, images or answers.",
  },
  {
    q: "How is my progress tracked?",
    a: "You mark a challenge done yourself once you have solved it on the platform. Challenges we host with an open licence can also check a flag.",
  },
  {
    q: "Is there a monthly CTF?",
    a: "Yes: a live OSINT CTF every month, free to enter. Members also get a members' leaderboard and write-ups after each case retires.",
  },
];

export function difficultyLabel(value) {
  return DIFFICULTY_LABELS[String(value || "").toLowerCase()] || "All levels";
}

/** "Start on TryHackMe" (contract cta_label wins). */
export function startLabel(item) {
  return item?.cta_label || `Start on ${item?.platform || "the platform"}`;
}

function minutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return number >= 60 ? `~${Math.round(number / 60)}h` : `~${number} min`;
}

export function DirectoryRow({ item, done, canTrack, onToggle, busy }) {
  const meta = [item.platform, difficultyLabel(item.difficulty), minutes(item.estimated_minutes), item.xp ? `${item.xp} XP` : ""].filter(Boolean).join(" · ");
  const skills = Array.isArray(item.skills) ? item.skills.slice(0, 4) : [];
  return (
    <li className="hp-dir__row" data-done={done ? "true" : "false"}>
      <div>
        <p className="hp-dir__title">
          {done ? <CheckCircleIcon className="hp-dir__icon" /> : <OpenCircleIcon className="hp-dir__icon" />} {item.title}
        </p>
        <p className="hp-dir__meta">{meta}</p>
        {skills.length ? <p className="hp-dir__meta">{skills.join(", ")}</p> : null}
        {item.hosting === "hosted" && item.licence ? (
          <p className="hp-dir__meta">
            Licence {item.licence}
            {item.attribution ? ` · ${item.attribution}` : ""}
          </p>
        ) : null}
      </div>
      <div className="hp-actions">
        {canTrack ? (
          <button type="button" className="hp-btn hp-btn--secondary hp-btn--sm" aria-pressed={done} disabled={busy} onClick={() => onToggle(item, !done)}>
            {done ? "Done" : "Mark done"}
          </button>
        ) : null}
        <a className="hp-btn hp-btn--primary hp-btn--sm" href={item.url} target="_blank" rel="noopener noreferrer">
          {startLabel(item)}
          <ArrowUpRightIcon className="hp-btn__arrow" />
          <span className="hp-sr"> (opens in a new tab)</span>
        </a>
      </div>
    </li>
  );
}

export default function FreeDirectoryPage() {
  const directory = useDirectory();
  const { isAuthenticated } = useAuth() || {};
  const [done, setDone] = useState(() => new Set());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setDone(new Set(Array.isArray(directory.me?.done) ? directory.me.done : []));
  }, [directory.me]);

  const toggle = async (item, next) => {
    setBusy(item.slug || String(item.id));
    setError("");
    try {
      await markDirectoryDone(item.slug || item.id, { done: next });
      setDone((previous) => {
        const copy = new Set(previous);
        if (next) copy.add(item.id);
        else copy.delete(item.id);
        return copy;
      });
    } catch {
      setError("Your progress could not be saved. Please try again.");
    } finally {
      setBusy("");
    }
  };

  const items = directory.items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const paths = directory.paths
    .map((path) => ({ ...path, items: (path.item_ids || []).map((id) => byId.get(id)).filter(Boolean) }))
    .filter((path) => path.items.length);
  const inPaths = new Set(paths.flatMap((path) => path.items.map((item) => item.id)));
  const others = items.filter((item) => !inPaths.has(item.id));
  const groups = [...paths, ...(others.length ? [{ key: "more", title: paths.length ? "More challenges" : "Challenges", summary: "", items: others }] : [])];
  const strip = [
    { label: "Challenges", value: items.length || null },
    { label: "Platforms", value: new Set(items.map((item) => item.platform).filter(Boolean)).size || null },
    { label: "Done", value: isAuthenticated && items.length ? `${done.size} / ${items.length}` : null },
    { label: "Price", value: "Free" },
  ];

  return (
    <div data-page="free-osint">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-free-title">
        <Tagline>No card, no catch</Tagline>
        <h1 id="hp-free-title" className="hp-display hp-display--xl">
          <span className="hp-display__line">
            Start <Hand>free</Hand>
          </span>
        </h1>
        <p className="hp-lead">
          A curated path through free OSINT challenges on other platforms, the monthly live CTF and progress you track yourself.
        </p>
        <div className="hp-actions">
          <ButtonLink to="#path" variant="primary" size="lg" arrow>
            See the path
          </ButtonLink>
          {isAuthenticated ? null : (
            <ButtonLink to="/login?next=/osint/free" variant="secondary" size="lg">
              Sign in to track progress
            </ButtonLink>
          )}
        </div>
        <StatStrip items={strip} label="The free directory in numbers" />
      </section>

      <section className="hp-band hp-band--tight-top" id="path" aria-labelledby="hp-path-title">
        <div className="hp-frame" style={{ maxWidth: "64rem" }}>
          <h2 id="hp-path-title" className="hp-h3">
            The learning path
          </h2>
          <p className="hp-body" style={{ marginTop: 12 }}>
            Each challenge opens on its own platform in a new tab. Come back and mark it done.
          </p>
          {error ? (
            <p className="hp-reason" role="alert" style={{ marginTop: 16 }}>
              {error}
            </p>
          ) : null}
          {directory.status === "loading" ? (
            <p className="hp-body hp-after-head" aria-busy="true">
              Loading the directory…
            </p>
          ) : groups.length ? (
            <div className="hp-after-head" style={{ display: "grid", gap: 56 }}>
              {groups.map((group, index) => (
                <section key={group.key} aria-labelledby={`hp-path-${group.key}`}>
                  <p className="hp-chapter">Step {index + 1}</p>
                  <h3 id={`hp-path-${group.key}`} className="hp-tier__title" style={{ fontSize: "1.5rem" }}>
                    {group.title}
                  </h3>
                  {group.summary ? <p className="hp-tier__summary">{group.summary}</p> : null}
                  <ul className="hp-dir" style={{ marginTop: 20 }}>
                    {group.items.map((item) => (
                      <DirectoryRow
                        key={item.id}
                        item={item}
                        done={done.has(item.id)}
                        canTrack={Boolean(isAuthenticated)}
                        busy={busy === (item.slug || String(item.id))}
                        onToggle={toggle}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <Notice eyebrow="Being curated" title="The directory is being checked" icon="clock" className="hp-after-head">
              We verify every free challenge before we list it. Meanwhile, see the <Link to="/tracks/osint">OSINT track</Link> or the{" "}
              <Link to="/pricing">plans</Link>.
            </Notice>
          )}
        </div>
      </section>

      <section className="hp-band hp-rule-top" aria-labelledby="hp-free-faq-title">
        <div className="hp-frame" style={{ maxWidth: "56rem" }}>
          <div className="hp-section-head hp-section-head--center">
            <Eyebrow>FAQ</Eyebrow>
            <h2 id="hp-free-faq-title" className="hp-h2">
              About the free <Hand>tier</Hand>
            </h2>
          </div>
          <FaqList items={FREE_FAQ} className="hp-after-head" />
        </div>
      </section>
    </div>
  );
}

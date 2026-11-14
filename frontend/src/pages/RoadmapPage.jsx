// /roadmap (PHILOSOPHY T8, BUILD_PLAN §2.1): left-aligned inner page, a tab
// bar between two hairlines, status cards (icon + word, never hue) with a
// footer link row. Tabs are a WAI-ARIA tablist (arrow keys move, Home/End).
import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { FREE_TIER, LABS } from "../data/freeLabs";
import LineArt from "../marketing/LineArt";
import { ROADMAP } from "../marketing/marketingContent";
import { ArrowRightIcon, CheckList, Eyebrow, StatusPill } from "../marketing/primitives";
import { PENTESTING_TIERS } from "../marketing/tiers";
import { useMarketingData } from "../marketing/useMarketingData";

export const ROADMAP_TABS = [
  { key: "now", label: "Now & next" },
  { key: "tracks", label: "Tracks" },
  { key: "map", label: "Full map" },
  { key: "teaching", label: "How we teach" },
];

function Panel({ status, statusKind, title, children, footer }) {
  return (
    <article className="hp-panel">
      <div className="hp-panel__head">
        <StatusPill kind={statusKind}>{status}</StatusPill>
        <h3 className="hp-panel__title">{title}</h3>
      </div>
      <div className="hp-panel__body">{children}</div>
      {footer ? (
        <Link className="hp-panel__foot" to={footer.to}>
          <span>{footer.label}</span>
          <ArrowRightIcon className="hp-btn__arrow" />
        </Link>
      ) : null}
    </article>
  );
}

function NowPanels({ data }) {
  const { osint, tiers, gate } = data;
  return (
    <div className="hp-panel-grid">
      <Panel status="Available now" statusKind="open" title="OSINT and free practice" footer={{ to: "/tracks/osint", label: "Open the OSINT track" }}>
        <p>Live OSINT cohorts, the labs and the free challenge directory are open today.</p>
        <ul className="hp-panel__list">
          {osint.slice(0, 3).map((course) => (
            <li key={course.id}>
              <Link to={`/courses/${course.id}`}>{course.card_title || course.title}</Link>
              <span className="hp-meta">Cohort</span>
            </li>
          ))}
          <li>
            <Link to={FREE_TIER.href}>Free OSINT challenges</Link>
            <span className="hp-meta">Free</span>
          </li>
          <li>
            <span>The labs ({LABS.length})</span>
            <span className="hp-meta">Open now</span>
          </li>
        </ul>
      </Panel>
      <Panel
        status={gate.enabled ? "Open" : "Coming soon"}
        statusKind={gate.enabled ? "open" : "soon"}
        title="Pentesting"
        footer={{ to: "/tracks/pentesting", label: "Browse the Pentesting tiers" }}
      >
        <p>Every tier, course and module outline is open to browse. Enrolment opens at launch.</p>
        <ul className="hp-panel__list">
          {PENTESTING_TIERS.map((tier) => {
            const found = tiers.find((item) => item.key === tier.key);
            return (
              <li key={tier.key}>
                <span>{found?.label || tier.label}</span>
                <span className="hp-meta">{found ? `${found.courses.length} courses` : "Being prepared"}</span>
              </li>
            );
          })}
        </ul>
      </Panel>
      <Panel status="Planned next" statusKind="planned" title="Memberships" footer={{ to: "/pricing", label: "See the plans" }}>
        <p>A Starter plan and the CTF Labs membership: new cases every month, a members' leaderboard and recorded classes. They open once prices are confirmed.</p>
      </Panel>
      <Panel status="Reference" statusKind="closed" title="Guides and policies" footer={{ to: "/faqs", label: "Read the FAQs" }}>
        <p>How enrolment, payments, recordings, certificates and refunds work, in one place.</p>
      </Panel>
    </div>
  );
}

function TrackPanels({ data }) {
  const { gate } = data;
  return (
    <div className="hp-panel-grid">
      <Panel status="Open" statusKind="open" title="Open Source Intelligence" footer={{ to: "/tracks/osint", label: "Explore OSINT" }}>
        <p>Find, verify and report what is public. Live cohorts, weekly reports, labs, the examination and the certificate.</p>
      </Panel>
      <Panel status={gate.enabled ? "Open" : "Coming soon"} statusKind={gate.enabled ? "open" : "soon"} title="Pentesting" footer={{ to: "/tracks/pentesting", label: "Explore Pentesting" }}>
        <p>Five tiers from first principles to enterprise attack paths, self-paced with live sessions.</p>
      </Panel>
    </div>
  );
}

function FullMap({ data }) {
  const { tiers } = data;
  const steps = [
    { title: "Free challenges", sub: "Learn the method on free public challenges.", to: FREE_TIER.href },
    { title: "OSINT cohort", sub: "Live classes, weekly reports, the labs.", to: "/tracks/osint" },
    ...PENTESTING_TIERS.map((tier) => {
      const found = tiers.find((item) => item.key === tier.key);
      return { title: found?.label || tier.label, sub: found?.summary || tier.summary, to: "/tracks/pentesting" };
    }),
  ];
  return (
    <ol className="hp-tl" style={{ marginTop: 40 }}>
      {steps.map((step, index) => (
        <li key={step.title} className="hp-tl__step">
          <span className="hp-tl__dot" aria-hidden="true" />
          <h3 className="hp-tl__heading">
            <span className="hp-tl__num" aria-hidden="true">
              {index + 1}.
            </span>
            <Link className="hp-tl__title" to={step.to}>
              {step.title}
            </Link>
          </h3>
          <p className="hp-tl__sub">{step.sub}</p>
        </li>
      ))}
    </ol>
  );
}

function Teaching() {
  return (
    <div className="hp-panel-grid">
      <article className="hp-panel">
        <div className="hp-panel__head">
          <LineArt name="path" className="hp-hero__mark" />
          <h3 className="hp-panel__title">A weekly rhythm</h3>
        </div>
        <div className="hp-panel__body">
          <CheckList
            items={[
              { lead: "Live classes.", text: "Three sessions a week, recorded and protected." },
              { lead: "Weekly report.", text: "Marked by an instructor, with written feedback." },
              { lead: "Labs.", text: "Cases with exact-answer validation." },
              { lead: "Examination.", text: "Timed and graded, then a certificate anyone can verify." },
            ]}
          />
        </div>
      </article>
      <article className="hp-panel">
        <div className="hp-panel__head">
          <LineArt name="certificate" className="hp-hero__mark" />
          <h3 className="hp-panel__title">Evidence over opinion</h3>
        </div>
        <div className="hp-panel__body">
          <p>Every finding is sourced, archived and reproducible. We teach lawful, ethical use of public information.</p>
        </div>
        <Link className="hp-panel__foot" to="/about">
          <span>About us</span>
          <ArrowRightIcon className="hp-btn__arrow" />
        </Link>
      </article>
    </div>
  );
}

export default function RoadmapPage() {
  const data = useMarketingData();
  const [active, setActive] = useState("now");
  const baseId = useId();
  const tabRefs = useRef({});

  const onKeyDown = (event) => {
    const index = ROADMAP_TABS.findIndex((tab) => tab.key === active);
    let next = null;
    if (event.key === "ArrowRight") next = ROADMAP_TABS[(index + 1) % ROADMAP_TABS.length];
    if (event.key === "ArrowLeft") next = ROADMAP_TABS[(index - 1 + ROADMAP_TABS.length) % ROADMAP_TABS.length];
    if (event.key === "Home") next = ROADMAP_TABS[0];
    if (event.key === "End") next = ROADMAP_TABS[ROADMAP_TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    setActive(next.key);
    tabRefs.current[next.key]?.focus();
  };

  return (
    <div className="hp-frame" data-page="roadmap">
      <header className="hp-page-head">
        <Eyebrow accent>{ROADMAP.eyebrow}</Eyebrow>
        <h1 className="hp-page-h1">{ROADMAP.title}</h1>
        <p className="hp-body">{ROADMAP.lead}</p>
      </header>
      <div className="hp-tabbar" role="tablist" aria-label="Roadmap views" onKeyDown={onKeyDown}>
        {ROADMAP_TABS.map((tab) => (
          <button
            key={tab.key}
            ref={(node) => {
              tabRefs.current[tab.key] = node;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.key}`}
            aria-controls={`${baseId}-panel-${tab.key}`}
            aria-selected={active === tab.key}
            tabIndex={active === tab.key ? 0 : -1}
            className="hp-tab"
            onClick={() => setActive(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {ROADMAP_TABS.map((tab) => (
        <section
          key={tab.key}
          role="tabpanel"
          id={`${baseId}-panel-${tab.key}`}
          aria-labelledby={`${baseId}-tab-${tab.key}`}
          hidden={active !== tab.key}
          tabIndex={0}
          style={{ paddingBottom: 96 }}
        >
          {active === tab.key ? (
            tab.key === "now" ? (
              <NowPanels data={data} />
            ) : tab.key === "tracks" ? (
              <TrackPanels data={data} />
            ) : tab.key === "map" ? (
              <FullMap data={data} />
            ) : (
              <Teaching />
            )
          ) : null}
        </section>
      ))}
    </div>
  );
}

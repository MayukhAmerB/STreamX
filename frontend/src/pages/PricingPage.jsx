// /pricing (PHILOSOPHY T5, owner OSINT membership rules): Free (directory +
// monthly CTF), Starter and the CTF Labs membership (the one highlighted plan),
// then the Pentesting plans, all "coming soon" while their switches are off.
// Prices show only once the owner confirms them (D10); every paid action is
// disabled-with-reason until the server says the plan is available.
import { useState } from "react";
import { Link } from "react-router-dom";

import { useCatalog } from "../marketing/catalogApi";
import { mergePlans, OSINT_PLANS, PENTESTING_PLANS } from "../marketing/plans";
import { PricingCard } from "../marketing/Pricing";
import { PRICING_BAND, PRICING_PAGE } from "../marketing/marketingContent";
import { TRUST_CHIPS } from "../marketing/PricingBand";
import { CheckIcon, cx, FaqList, Hand, Notice, Tagline } from "../marketing/primitives";

export const COMPARISON_ROWS = [
  { feature: "Free OSINT challenge directory and learning path", free: true, starter: true, ctf_labs: true },
  { feature: "Monthly live OSINT CTF", free: true, starter: true, ctf_labs: true },
  { feature: "Easy and medium labs", free: false, starter: true, ctf_labs: true },
  { feature: "Expert and professional labs", free: false, starter: false, ctf_labs: true },
  { feature: "New cases every month", free: false, starter: false, ctf_labs: true },
  { feature: "Recorded classes", free: false, starter: "One chosen batch", ctf_labs: "This month's bundle" },
  { feature: "Hints, write-ups and video walkthroughs", free: false, starter: false, ctf_labs: true },
  { feature: "OSINT certification exam", free: false, starter: false, ctf_labs: true },
  { feature: "Members' leaderboard, XP, badges and rank", free: false, starter: false, ctf_labs: true },
  { feature: "Members' community and live Q&A", free: false, starter: false, ctf_labs: true },
];

export const PRICING_FAQ = [
  {
    q: "What is free, exactly?",
    a: "The free plan is a curated directory of free OSINT challenges hosted on other platforms (we link out to them), our learning path through them with progress you track yourself, and the monthly live CTF. No card is needed.",
  },
  {
    q: "Why can't I join a membership yet?",
    a: "Paid plans open only after their prices are confirmed. Until then the cards say so and nothing can be charged.",
  },
  {
    q: "How does billing work?",
    a: "Memberships renew every month through Razorpay and can be cancelled at any time; access continues until the end of the period you paid for. Prices are in Indian rupees.",
  },
  {
    q: "What does 'included this month' mean?",
    a: "Each month the CTF Labs membership includes a bundle of recorded courses. Members can watch them while they are in that month's bundle; some courses are always included.",
  },
  {
    q: "Is Pentesting part of any plan today?",
    a: "Not yet. Every Pentesting course and module outline is open to browse, and enrolment opens at launch.",
  },
  {
    q: "Where are the prices for live OSINT cohorts?",
    a: (
      <>
        Each cohort has its own fees on its course page. See <Link to="/courses">all courses</Link>, the <Link to="/terms">terms</Link> and the{" "}
        <Link to="/faqs">FAQs</Link> for refunds and invoices.
      </>
    ),
  },
];

function Cell({ value }) {
  if (value === true) {
    return (
      <span className="hp-table__yes">
        <CheckIcon />
        <span className="hp-sr">Included</span>
      </span>
    );
  }
  if (!value) {
    return (
      <span className="hp-table__no">
        <span aria-hidden="true">—</span>
        <span className="hp-sr">Not included</span>
      </span>
    );
  }
  return <span>{value}</span>;
}

export function ComparisonTable({ plans }) {
  const columns = [
    { key: "free", title: plans.find((plan) => plan.key === "free")?.title || "Free" },
    { key: "starter", title: plans.find((plan) => plan.key === "starter")?.title || "Starter" },
    { key: "ctf_labs", title: plans.find((plan) => plan.key === "ctf_labs")?.title || "CTF Labs membership", recommended: true },
  ];
  return (
    <div className="hp-table-wrap" role="region" aria-labelledby="hp-compare-title" tabIndex={0}>
      <table className="hp-table">
        <caption className="hp-sr" id="hp-compare-title">
          What each OSINT plan includes
        </caption>
        <thead>
          <tr>
            <th scope="col">Feature</th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.recommended ? "is-recommended" : undefined}>
                {column.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COMPARISON_ROWS.map((row) => (
            <tr key={row.feature}>
              <th scope="row">{row.feature}</th>
              {columns.map((column) => (
                <td key={column.key} className={column.recommended ? "is-recommended" : undefined}>
                  <Cell value={row[column.key]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Monthly / yearly segmented toggle (aria-pressed buttons in a labelled group). */
export function PeriodToggle({ value, onChange }) {
  return (
    <div className="hp-seg" role="group" aria-label="Billing period">
      <button type="button" aria-pressed={value === "monthly"} onClick={() => onChange("monthly")}>
        Monthly
      </button>
      <button type="button" aria-pressed={value === "yearly"} onClick={() => onChange("yearly")}>
        Yearly<span className="hp-seg__save">Save 40%</span>
      </button>
    </div>
  );
}

function IncludedThisMonth({ plan }) {
  const bundle = plan?.included_this_month;
  const courses = Array.isArray(bundle?.courses) ? bundle.courses : [];
  if (!courses.length) return null;
  return (
    <Notice eyebrow={`Included this month${bundle.month ? ` · ${bundle.month}` : ""}`} title="Recorded courses in the membership" className="hp-after-head">
      <ul className="hp-panel__list">
        {courses.map((course) => (
          <li key={course.id || course.title}>
            {course.id ? <Link to={`/courses/${course.id}`}>{course.title}</Link> : course.title}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

export default function PricingPage() {
  const catalog = useCatalog();
  const [period, setPeriod] = useState("monthly");
  const osint = mergePlans(OSINT_PLANS, catalog.plans);
  // One golden plan per page (PHILOSOPHY §3.1): a Pentesting plan glows only once it can be bought.
  const pentesting = mergePlans(PENTESTING_PLANS, catalog.plans, { period }).map((plan) => ({
    ...plan,
    highlighted: Boolean(plan.highlighted && plan.state === "available"),
    ...(plan.key === "pentesting_membership" ? { billing_period: period, slot: <PeriodToggle value={period} onChange={setPeriod} /> } : {}),
  }));
  const membership = osint.find((plan) => plan.key === "ctf_labs");

  return (
    <div className="hp-pricing-page">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-pricing-title">
        <Tagline>{PRICING_PAGE.tagline}</Tagline>
        <h1 id="hp-pricing-title" className="hp-display">
          <span className="hp-display__line">{PRICING_PAGE.line1}</span>{" "}
          <span className="hp-display__line">
            {PRICING_PAGE.line2Before} <Hand>{PRICING_PAGE.accent}</Hand>.
          </span>
        </h1>
        <p className="hp-lead">{PRICING_PAGE.lead}</p>
        <ul className="hp-trust" aria-label={PRICING_BAND.trustLabel}>
          {TRUST_CHIPS.map((chip) => (
            <li key={chip}>{chip}</li>
          ))}
        </ul>
      </section>

      <section className="hp-band hp-band--tight-top" aria-labelledby="hp-osint-plans-title" id="osint">
        <div className="hp-frame">
          <h2 id="hp-osint-plans-title" className="hp-sr">
            OSINT plans
          </h2>
          <div className={cx("hp-plans", "hp-plans--3")} style={{ marginTop: 0 }}>
            {osint.map((plan) => (
              <PricingCard key={plan.key} plan={plan} />
            ))}
          </div>
          <IncludedThisMonth plan={membership} />
          <ComparisonTable plans={osint} />
        </div>
      </section>

      <section className="hp-band hp-rule-top" aria-labelledby="hp-pt-plans-title" id="pentesting">
        <div className="hp-frame">
          <div className="hp-pricing-head">
            <p className="hp-eyebrow">{PRICING_PAGE.pentesting.eyebrow}</p>
            <h2 id="hp-pt-plans-title" className="hp-h2" style={{ marginTop: 12 }}>
              {PRICING_PAGE.pentesting.before} <Hand>{PRICING_PAGE.pentesting.accent}</Hand>
            </h2>
            <p className="hp-lead" style={{ marginTop: 20 }}>
              {PRICING_PAGE.pentesting.lead}
            </p>
          </div>
          <div className="hp-plans hp-plans--3">
            {pentesting.map((plan) => (
              <PricingCard key={plan.key} plan={plan} />
            ))}
          </div>
          <p className="hp-center hp-body" style={{ marginTop: 24 }}>
            <Link className="hp-text-link" to="/tracks/pentesting">
              {PRICING_PAGE.pentesting.link}
            </Link>
          </p>
        </div>
      </section>

      <section className="hp-band hp-rule-top" aria-labelledby="hp-pricing-faq-title" id="faq">
        <div className="hp-frame" style={{ maxWidth: "56rem" }}>
          <div className="hp-section-head hp-section-head--center">
            <p className="hp-faq-kicker">{PRICING_PAGE.faq.kicker}</p>
            <h2 id="hp-pricing-faq-title" className="hp-h2">
              {PRICING_PAGE.faq.before} <Hand>{PRICING_PAGE.faq.accent}</Hand>
            </h2>
          </div>
          <FaqList items={PRICING_FAQ} className="hp-after-head" />
        </div>
      </section>
    </div>
  );
}

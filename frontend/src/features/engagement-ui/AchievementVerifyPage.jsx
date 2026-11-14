// Public verification page /achievements/:slug (no sign-in). OWNER: WS-LEARN.
// GET /api/engagement/achievements/<slug>/ answers `valid: false` for a
// revoked achievement and 404 for an unknown slug.
import "./AchievementVerify.css";

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { siteBrand } from "../../config/siteBrand";
import { apiData } from "../../utils/api";
import { fetchPublicAchievement } from "./engagementApi";
import { formatEarnedDate } from "./engagementModel";
import { BadgeMedal } from "./EngagementParts";

const KIND_LABEL = { badge: "Badge", level: "Rank reached", course: "Course completed" };

function useAchievement(slug) {
  const [state, setState] = useState({ status: "loading", data: null });
  useEffect(() => {
    let active = true;
    setState({ status: "loading", data: null });
    fetchPublicAchievement(slug)
      .then((response) => {
        if (active) setState({ status: "ready", data: apiData(response, null) });
      })
      .catch((error) => {
        if (!active) return;
        const status = error?.response?.status;
        setState({ status: status === 404 ? "missing" : status === 403 ? "off" : "error", data: null });
      });
    return () => {
      active = false;
    };
  }, [slug]);
  return state;
}

export default function AchievementVerifyPage() {
  const { slug = "" } = useParams();
  const { status, data } = useAchievement(slug);

  useEffect(() => {
    if (data?.title) document.title = `${data.title}: verified achievement | ${siteBrand.name}`;
  }, [data?.title]);

  const valid = status === "ready" && data?.valid;
  return (
    <main className="av-page">
      <div className="av-frame">
        <p className="av-kicker">
          <span className="av-kicker__first">Verify</span>
          <span className="av-kicker__rule" aria-hidden="true" />
          <span>{siteBrand.name}</span>
        </p>
        {status === "loading" ? (
          <p className="av-status" role="status">
            Checking this achievement…
          </p>
        ) : null}
        {status === "missing" || status === "error" || status === "off" ? (
          <section className="av-card av-card--invalid" aria-labelledby="av-title">
            <p className="av-badge av-badge--critical">
              <span aria-hidden="true">✕</span> Not verified
            </p>
            <h1 id="av-title" className="av-title">
              {status === "missing" ? "We could not find this achievement" : "This achievement cannot be checked right now"}
            </h1>
            <p className="av-body">
              {status === "missing"
                ? "The link may be mistyped, or it may never have been issued. Ask the holder for the link from their Achievements page."
                : "Please try again in a few minutes."}
            </p>
          </section>
        ) : null}
        {status === "ready" && data ? (
          <section className={`av-card${valid ? "" : " av-card--invalid"}`} aria-labelledby="av-title">
            <div className="av-card__head">
              <BadgeMedal badgeKey={data.key} tier={data.tier} earned={valid} size={72} />
              <p className={`av-badge${valid ? " av-badge--valid" : " av-badge--critical"}`}>
                <span aria-hidden="true">{valid ? "✓" : "✕"}</span> {valid ? "Verified" : "Revoked"}
              </p>
            </div>
            <p className="av-kind">{KIND_LABEL[data.kind] || "Achievement"}</p>
            <h1 id="av-title" className="av-title">
              {data.title}
            </h1>
            {data.subtitle ? <p className="av-body">{data.subtitle}</p> : null}
            <dl className="av-facts">
              <div>
                <dt>Awarded to</dt>
                <dd>{data.recipient_name || "A learner"}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatEarnedDate(data.earned_at) || "Unknown"}</dd>
              </div>
              <div>
                <dt>Issued by</dt>
                <dd>{siteBrand.name}</dd>
              </div>
            </dl>
            {valid ? (
              <div className="av-actions">
                {data.certificate_url ? (
                  <a className="av-button av-button--primary" href={data.certificate_url} download>
                    Download certificate (PDF)
                  </a>
                ) : null}
                {data.share_card_url ? (
                  <a className="av-button" href={data.share_card_url} target="_blank" rel="noopener noreferrer">
                    View share card<span className="av-sr"> (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="av-body">This achievement was withdrawn by {siteBrand.name} and no longer counts.</p>
            )}
          </section>
        ) : null}
        <p className="av-foot">
          <Link to="/courses">Explore our courses</Link>
        </p>
      </div>
    </main>
  );
}

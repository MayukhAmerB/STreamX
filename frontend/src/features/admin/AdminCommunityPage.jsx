// /console/admin/community (?tab=questions) (plan §4.3). OWNER: WS-G.
// Wave 1: the Questions tab (WS-D2's list). Comments, reviews and
// announcements live in the back office until their Console tabs ship.
import { Launch } from "@carbon/icons-react";
import { useSearchParams } from "react-router-dom";
import { PageHeader, ScrollTabs } from "../app-shell/ui";
import { QuestionsList } from "../questions";
import "./admin.scss";

export const COMMUNITY_TABS = [
  { key: "questions", label: "Questions" },
  {
    key: "comments",
    label: "Comments",
    href: "/admin/courses/lecturecomment/",
    body: "Hide or restore comments students leave on lectures.",
  },
  { key: "reviews", label: "Reviews", href: "/admin/courses/coursereview/", body: "Publish or hide course reviews." },
  {
    key: "announcements",
    label: "Announcements",
    href: "/admin/notifications/notification/",
    body: "Send a notification to students.",
  },
];

export default function AdminCommunityPage() {
  const [params, setParams] = useSearchParams();
  const active = COMMUNITY_TABS.find((tab) => tab.key === params.get("tab")) || COMMUNITY_TABS[0];
  const tabs = COMMUNITY_TABS.map((tab) => ({
    key: tab.key,
    label: tab.label,
    onClick: () => setParams(tab.key === "questions" ? {} : { tab: tab.key }, { replace: true }),
  }));
  return (
    <div className="adm-page adm-page--list">
      <PageHeader title="Community" description="Answer lecture questions and look after comments and reviews." eyebrow={null} />
      <ScrollTabs tabs={tabs} activeKey={active.key} label="Community sections" />
      {active.key === "questions" ? (
        <QuestionsList />
      ) : (
        <section className="adm-elsewhere" aria-labelledby="adm-elsewhere-title">
          <span className="adm-eyebrow-rule adm-eyebrow-rule--neutral" aria-hidden="true" />
          <h2 id="adm-elsewhere-title" className="adm-elsewhere__title">
            {active.label} live in the back office for now
          </h2>
          <p className="adm-quiet">{active.body} This tab moves into the Console in a later round.</p>
          <a className="adm-button adm-button--secondary" href={active.href}>
            Open {active.label.toLowerCase()} <Launch size={16} aria-hidden="true" />
          </a>
        </section>
      )}
    </div>
  );
}

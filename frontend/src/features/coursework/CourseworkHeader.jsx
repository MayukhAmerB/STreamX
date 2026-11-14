// Coursework hub header (T2 with ScrollTabs, plan §3.4). OWNER: WS-C.
// One hub, three tabs: This week (/reports), Grades (/gradebook), Exams
// (/coursework/exams). Each tab is its own URL so links and E2E journeys stay.
import "./Coursework.scss";

import { PageHeader, ScrollTabs } from "../app-shell/ui";

export const COURSEWORK_TABS = Object.freeze([
  { key: "week", label: "This week", href: "/reports" },
  { key: "grades", label: "Grades", href: "/gradebook" },
  { key: "exams", label: "Exams", href: "/coursework/exams" },
]);

const DESCRIPTIONS = {
  week: "Your weekly report: one target, uploaded before the deadline.",
  grades: "Your report marks and exam results, per course.",
  exams: "Open and upcoming exams for your batch.",
};

export default function CourseworkHeader({ active = "week", badges = {} }) {
  const tabs = COURSEWORK_TABS.map((tab) => (badges[tab.key] != null ? { ...tab, badge: badges[tab.key] } : tab));
  return (
    <div className="cw-header">
      <PageHeader title="Coursework" description={DESCRIPTIONS[active]} />
      <ScrollTabs tabs={tabs} activeKey={active} label="Coursework" />
    </div>
  );
}

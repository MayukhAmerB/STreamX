// Task C (hybrid release): the reward band on the Friday landing, /rewards,
// the profile record tabs (Rewards / Batches / Certificates) with highlight
// toggles, and highlights on the public profile (handles only).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: false, user: null }) }));

import apiClient from "../../api/client";
import { fire, renderTree, textOf } from "../../test-utils/renderTree";
import { isFridayWebsitePath } from "../../layouts/AppLayout";
import { LEVELS } from "../engagement-ui/engagementModel";
import { HighlightsStrip } from "../profiles/ProfileView";
import LandingRewardsBand from "./LandingRewardsBand";
import { BatchesPanel, CertificatesPanel, groupXpByDay, RewardsPanel, useRewardHistory } from "./RewardRecord";
import RewardsPage from "./RewardsPage";
import { certificatePdfUrl, highlightError, MAX_HIGHLIGHTS, toggleHighlight } from "./rewardsApi";
import { BADGE_GROUPS, REPORT_BASE_XP, REPORT_MARK_BONUS } from "./rewardsContent";
import { ReportBonusTiers } from "./RewardsVisuals";

const render = (node, location = "/") => renderToStaticMarkup(<StaticRouter location={location}>{node}</StaticRouter>);

const HISTORY = {
  summary: { total_xp: 4870, level: 3, badges_count: 2, current_streak: 3, best_streak: 9 },
  xp: {
    items: [
      { id: 3, date: "2026-11-14T18:22:05+05:30", day: "2026-11-14", source: "lecture_completed", source_label: "Lecture completed", amount: 20, description: "Lecture completed" },
      { id: 2, date: "2026-11-14T10:00:00+05:30", day: "2026-11-14", source: "live", source_label: "Live class", amount: 150, description: "Live class attended" },
      { id: 1, date: "2026-11-12T10:00:00+05:30", day: "2026-11-12", source: "manual", source_label: "Staff award", amount: 4700, description: "Staff award" },
    ],
    page: 1,
    page_size: 25,
    total: 3,
    has_more: false,
  },
  badges: [
    { key: "first_lecture", title: "First Lecture", description: "Complete your first lecture.", tier: "bronze", earned_at: "2026-10-02T10:00:00+00:00", highlighted: true },
    { key: "streak_3", title: "On a Roll", description: "Keep a 3-day study streak.", tier: "bronze", earned_at: "2026-10-05T10:00:00+00:00", highlighted: false },
  ],
  batches: [
    { enrollment_id: 12, course_id: 3, course_title: "OSINT Investigator", course_slug: "osint", batch: "Batch 3", status: "active", payment_status: "paid", access_type: "lifetime", enrolled_at: "2026-08-01T00:00:00Z", start_date: "2026-08-10", access_expires_at: null },
  ],
  certificates: [
    { reference: "ASI-2026-OSINT-000042-7", type: "OSINT", type_label: "OSINT certification", title: "Certified OSINT Investigator", issued_at: "2026-11-14T00:00:00Z", issued_on: "2026-11-14", valid: true, highlighted: false, url: "/certificates/ASI-2026-OSINT-000042-7" },
    { reference: "ASI-2026-OSINT-000043-5", type: "OSINT", type_label: "OSINT certification", title: "Certified OSINT Investigator", issued_at: "2026-11-01T00:00:00Z", issued_on: "2026-11-01", valid: false, highlighted: false, url: "/certificates/ASI-2026-OSINT-000043-5" },
  ],
  highlights: { badges: ["first_lecture"], certificates: [], max: 3 },
  engagement_enabled: true,
};

describe("rewards api helpers", () => {
  it("toggles a highlight on and off and enforces the cap of 3", () => {
    const base = { badges: ["a"], certificates: [], max: 3 };
    expect(toggleHighlight(base, "badge", "a").next).toEqual({ badges: [], certificates: [] });
    expect(toggleHighlight(base, "certificate", "REF").next).toEqual({ badges: ["a"], certificates: ["REF"] });
    const full = { badges: ["a", "b"], certificates: ["REF"], max: 3 };
    expect(toggleHighlight(full, "badge", "c").error).toMatch(/up to 3/);
    expect(toggleHighlight(full, "badge", "a").next).toEqual({ badges: ["b"], certificates: ["REF"] });
    expect(MAX_HIGHLIGHTS).toBe(3);
  });

  it("reads the first validation message of a 400", () => {
    const error = { response: { data: { code: "validation_failed", message: "Invalid", errors: { badges: ["You do not hold that badge."] } } } };
    expect(highlightError(error)).toBe("You do not hold that badge.");
    expect(highlightError({ response: { data: { message: "Nope" } } })).toBe("Nope");
  });

  it("builds the owner-only PDF link under the API base", () => {
    expect(certificatePdfUrl("ASI-1/2")).toBe("/api/engagement/certificates/ASI-1%2F2/certificate.pdf");
  });

  it("groups the XP timeline by day with a daily total", () => {
    const groups = groupXpByDay(HISTORY.xp.items);
    expect(groups.map((group) => [group.day, group.items.length, group.total])).toEqual([
      ["2026-11-14", 2, 170],
      ["2026-11-12", 1, 4700],
    ]);
  });
});

describe("landing reward band (Friday landing, before the footer)", () => {
  it("shows the eight ranks with real thresholds, the XP cards, the podium and links", () => {
    const html = render(<LandingRewardsBand />);
    for (const level of LEVELS) {
      expect(html).toContain(level.title);
      expect(html).toContain(`${new Intl.NumberFormat("en-IN").format(level.min_xp)} XP`);
    }
    expect(html).toContain("Recruit");
    expect(html).toContain("Elite Operator");
    expect(html).toContain("150 XP");
    expect(html).toContain("Weekly leaderboard prizes");
    expect(html).toContain('href="/rewards"');
    expect(html).toContain("See all rewards");
    expect(html).toContain('href="/hall-of-fame"');
    // No gold (golden white #f3e2b3 / accent) on new pieces.
    expect(html.toLowerCase()).not.toMatch(/f3e2b3|text-accent|bg-accent/);
  });
});

describe("report mark bonus tiers (owner, Nov 2026)", () => {
  const TIERS = ["10/10", "+300", "9/10", "+200", "8/10", "+130", "7/10", "+80", "6/10", "+40"];

  it("lists every tier on the landing band, /rewards and the achievements copy", () => {
    for (const html of [render(<LandingRewardsBand />), render(<RewardsPage />, "/rewards")]) {
      expect(html).toContain('data-testid="report-bonus-tiers"');
      for (const piece of TIERS) expect(html).toContain(piece);
      expect(html).toContain("Every report earns 30 XP (40 on time)");
      expect(html).toContain("Up to 340 XP a report");
    }
    const tiers = render(<ReportBonusTiers title="Earn more XP: the weekly report bonus" />);
    expect(tiers).toContain("Earn more XP: the weekly report bonus");
    expect(tiers).toContain("A regrade adjusts the bonus up or down");
  });

  it("mirrors the backend default table", () => {
    expect(REPORT_MARK_BONUS.map((tier) => [tier.score, tier.xp])).toEqual([[10, 300], [9, 200], [8, 130], [7, 80], [6, 40]]);
    expect(REPORT_BASE_XP).toEqual({ submitted: 30, onTime: 40 });
  });
});

describe("/rewards page", () => {
  it("explains XP, ranks, every badge, weekly prizes, the Monthly CTF and certificates", () => {
    const html = render(<RewardsPage />, "/rewards");
    expect(html).toContain("How XP is earned");
    expect(html).toContain("Eight ranks");
    for (const group of BADGE_GROUPS) for (const badge of group.badges) expect(html).toContain(badge.title);
    expect(html).toContain("Weekly leaderboard prizes");
    expect(html).toContain("Monthly OSINT CTF");
    expect(html).toContain("Certificates");
    expect(html).toContain('href="/hall-of-fame"');
    // Certificates are explained only: no certificate reference or link appears.
    expect(html).not.toMatch(/ASI-\d{4}-/);
    expect(html).not.toContain("/certificates/");
    expect(html.toLowerCase()).not.toMatch(/f3e2b3|text-accent|bg-accent/);
  });

  it("is a Friday-styled website page", () => {
    expect(isFridayWebsitePath("/rewards")).toBe(true);
    expect(isFridayWebsitePath("/rewards/")).toBe(true);
  });
});

describe("profile record tabs", () => {
  beforeEach(() => {
    apiClient.get.mockReset();
    apiClient.patch.mockReset();
  });

  function Harness() {
    const record = useRewardHistory();
    if (record.state.status !== "ready") return <p>{record.state.status}</p>;
    return (
      <MemoryRouter>
        <RewardsPanel record={record} />
        <BatchesPanel record={record} />
        <CertificatesPanel record={record} />
        <p data-notice="true">{record.notice}</p>
      </MemoryRouter>
    );
  }

  const isButton = (label) => (node) => node.type === "button" && String(node.props["aria-label"] || "").startsWith(label);

  it("renders rank progress, badges, the XP timeline, batches and own certificates", async () => {
    apiClient.get.mockResolvedValue({ data: { data: HISTORY } });
    const tree = await renderTree(<Harness />);
    expect(apiClient.get).toHaveBeenCalledWith("/engagement/me/history/", { params: { page: 1, page_size: 25 } });
    const text = tree.text();
    expect(text).toContain("Operator");
    expect(text).toContain("4,870 XP");
    expect(text).toContain("1,130 XP to Analyst");
    expect(text).toContain("First Lecture");
    expect(text).toContain("Live class attended");
    expect(text).toContain("+170 XP");
    expect(text).toContain("OSINT Investigator");
    expect(text).toContain("Batch 3");
    expect(text).toContain("Active");
    expect(text).toContain("Lifetime");
    expect(text).toContain("ASI-2026-OSINT-000042-7");
    expect(text).toContain("1 of 3 highlighted");
    // View + owner-only download for a valid certificate; a revoked one cannot be highlighted or downloaded.
    const links = tree.all((node) => node.type === "a").map((node) => node.props.href);
    expect(links).toContain("/certificates/ASI-2026-OSINT-000042-7");
    expect(links).toContain("/api/engagement/certificates/ASI-2026-OSINT-000042-7/certificate.pdf");
    expect(links).not.toContain("/api/engagement/certificates/ASI-2026-OSINT-000043-5/certificate.pdf");
    expect(tree.all(isButton("Highlight Certified OSINT")).length).toBe(1);
    // The highlighted badge is pressed.
    const pressed = tree.find(isButton("Remove highlight from First Lecture"));
    expect(pressed.props["aria-pressed"]).toBe(true);
    await tree.unmount();
  });

  it("highlights a certificate through PATCH /engagement/me/highlights/", async () => {
    apiClient.get.mockResolvedValue({ data: { data: HISTORY } });
    apiClient.patch.mockResolvedValue({ data: { data: { badges: ["first_lecture"], certificates: ["ASI-2026-OSINT-000042-7"], max: 3 } } });
    const tree = await renderTree(<Harness />);
    await fire(tree.find(isButton("Highlight Certified OSINT")), "onClick");
    expect(apiClient.patch).toHaveBeenCalledWith("/engagement/me/highlights/", {
      badges: ["first_lecture"],
      certificates: ["ASI-2026-OSINT-000042-7"],
    });
    expect(tree.text()).toContain("2 of 3 highlighted");
    expect(tree.text()).toContain("Highlights saved");
    await tree.unmount();
  });

  it("rolls back and shows the server message when saving fails", async () => {
    apiClient.get.mockResolvedValue({ data: { data: HISTORY } });
    apiClient.patch.mockRejectedValue({ response: { status: 400, data: { code: "validation_failed", errors: { badges: ["You do not hold that badge."] } } } });
    const tree = await renderTree(<Harness />);
    await fire(tree.find(isButton("Highlight On a Roll")), "onClick");
    const notice = tree.find((node) => node.props?.["data-notice"] === "true");
    expect(textOf(notice)).toBe("You do not hold that badge.");
    expect(tree.text()).toContain("1 of 3 highlighted");
    await tree.unmount();
  });

  it("refuses a fourth highlight without calling the API", async () => {
    apiClient.get.mockResolvedValue({
      data: { data: { ...HISTORY, highlights: { badges: ["first_lecture", "streak_3"], certificates: ["ASI-2026-OSINT-000042-7"], max: 3 } } },
    });
    const tree = await renderTree(<Harness />);
    expect(tree.text()).toContain("3 of 3 highlighted");
    expect(tree.find(isButton("Highlight "))).toBeNull();
    await tree.unmount();
  });
});

describe("public profile highlights", () => {
  it("shows the owner's highlights as badges, never a certificate reference or link", () => {
    const html = render(
      <HighlightsStrip
        items={[
          { kind: "badge", key: "first_lecture", title: "First Lecture", tier: "bronze", earned_at: "2026-10-02" },
          { kind: "certificate", title: "Certified OSINT Investigator", type: "OSINT", issued_on: "2026-11-14" },
        ]}
      />
    );
    expect(html).toContain("First Lecture");
    expect(html).toContain("bronze badge");
    expect(html).toContain("Certified OSINT Investigator");
    expect(html).toContain("Certified");
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/ASI-\d{4}-/);
  });

  it("renders nothing without highlights", () => {
    expect(render(<HighlightsStrip items={[]} />)).toBe("");
    expect(render(<HighlightsStrip />)).toBe("");
  });
});

describe("wiring", () => {
  const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  it("puts the reward band last on the Friday landing, right before the footer", () => {
    const source = read("../../pages/LandingPage.jsx");
    const band = source.indexOf("<LandingRewardsBand />");
    expect(band).toBeGreaterThan(source.lastIndexOf("</SectionCard>"));
  });

  it("links /rewards from the footer only, not the navbar", () => {
    expect(read("../../components/AppFooter.jsx")).toContain('to: "/rewards"');
    expect(read("../../components/Navbar.jsx")).not.toContain("/rewards");
  });

  it("loads the compact Console type scale last, with 14px body and 22-24px page titles", () => {
    const app = read("../app-shell/styles/carbon-app.scss");
    expect(app.trim().split(/\r?\n/).pop()).toContain("console-type");
    const scale = read("../app-shell/styles/_console-type.scss");
    expect(scale).toMatch(/--console-type-body: 0\.875rem/);
    expect(scale).toMatch(/--console-type-page-title: 1\.375rem/);
    expect(scale).toMatch(/--console-type-page-title: 1\.5rem/);
    expect(scale).toMatch(/--console-type-section: 1rem/);
    expect(scale).toMatch(/--console-type-panel: 0\.9375rem/);
  });
});

// "Your journey so far" (owner rule 6), the shell's one-dialog-at-a-time
// queue, legacy badges and the Founding Glow profile frame.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
// Radix portals need a DOM; a pass-through keeps the open/close contract.
vi.mock("../../kit/Dialog", () => ({
  Dialog: ({ open, onOpenChange, children }) => (open ? <section data-dialog="true" onOpenChange={onOpenChange}>{children}</section> : null),
  DialogContent: ({ children, ...props }) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogFooter: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <h2>{children}</h2>,
  DialogDescription: ({ children }) => <p>{children}</p>,
}));

import apiClient from "../../api/client";
import { AuthContext } from "../../context/AuthContext";
import { act, fire, renderTree } from "../../test-utils/renderTree";
import { dialogTurn, DIALOG_ORDER, holdDialog, releaseDialog, resetDialogQueue } from "../app-shell/dialogQueue";
import ProfileView from "../profiles/ProfileView";
import { badgeGlyph, journeyShareUrl, normalizeJourney, orderJourneyBadges } from "./engagementModel";
import JourneyWelcome, { JourneyPanel, resetJourneyWelcome, shareJourney } from "./JourneyWelcome";

const STUDENT = { id: 7, role: "student" };

const PAYLOAD = {
  show: true,
  journey: {
    cohort: "active",
    active: true,
    graduate: false,
    batches: [2],
    first_enrolled_at: "2026-01-10T10:00:00+05:30",
    xp: 2350,
    level: { number: 2, key: "operative", title: "Operative", min_xp: 1500 },
    next_level: { number: 3, key: "operator", title: "Operator", min_xp: 3500 },
    best_streak: 9,
    position: { batch_id: 4, all_time_rank: 3 },
    badges: [
      { key: "first_lecture", title: "First Lecture", description: "Complete your first lecture.", tier: "bronze", legacy: false },
      { key: "batch_pioneer_2", title: "Batch Pioneer — Batch 2", description: "", tier: "silver", legacy: true },
      { key: "founding_member", title: "Founding Member", description: "", tier: "gold", legacy: true },
      { key: "founding_operative", title: "Founding Operative", description: "", tier: "platinum", legacy: true },
    ],
    certificates: [
      { reference: "ASI-2026-BADGE-000012-K", title: "Founding Member", heading: "Certificate of Founding Membership", issued_at: "2026-12-01T00:00:00+05:30", url: "https://example.test/certificates/ASI-2026-BADGE-000012-K" },
    ],
    founding_glow: { active: true, ends_at: "2026-12-31T00:00:00+05:30" },
    share: { handle: "quiet_cipher", profile_path: "/u/quiet_cipher", certificate_url: "https://example.test/certificates/ASI-2026-BADGE-000012-K" },
  },
};

const respond = (data) => apiClient.get.mockResolvedValue({ data: { success: true, data } });

async function mountJourney(user = STUDENT) {
  const tree = await renderTree(
    <AuthContext.Provider value={{ user }}>
      <JourneyWelcome />
    </AuthContext.Provider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.post.mockResolvedValue({ data: { success: true, data: { show: false } } });
  resetDialogQueue();
  resetJourneyWelcome();
});

afterEach(() => {
  resetDialogQueue();
});

describe("journey model", () => {
  it("shows nothing unless the server says show", () => {
    expect(normalizeJourney({ show: false, journey: null })).toBeNull();
    expect(normalizeJourney(null)).toBeNull();
    expect(normalizeJourney({ show: true, journey: null })).toBeNull();
    const view = normalizeJourney(PAYLOAD);
    expect(view.rank).toBe(3);
    expect(view.glow).toEqual({ endsAt: "2026-12-31T00:00:00+05:30" });
  });

  it("puts legacy badges first, highest first", () => {
    expect(orderJourneyBadges(PAYLOAD.journey.badges).map((badge) => badge.key)).toEqual([
      "founding_operative",
      "founding_member",
      "batch_pioneer_2",
      "first_lecture",
    ]);
  });

  it("shares the profile, else the certificate", () => {
    const view = normalizeJourney(PAYLOAD);
    expect(journeyShareUrl(view, "https://site.test")).toBe("https://site.test/u/quiet_cipher");
    const noProfile = { ...view, share: { ...view.share, profilePath: "" } };
    expect(journeyShareUrl(noProfile, "https://site.test")).toBe(PAYLOAD.journey.share.certificate_url);
  });

  it("gives legacy and podium badges their own glyphs (unknown keys still render)", () => {
    expect(badgeGlyph("founding_operative")).toBe("founding");
    expect(badgeGlyph("founding_graduate")).toBe("founding");
    expect(badgeGlyph("batch_pioneer_12")).toBe("pioneer");
    expect(badgeGlyph("podium_week")).toBe("podium");
    expect(badgeGlyph("something_new")).toBe("lecture");
  });
});

describe("journey panel", () => {
  it("renders rank, XP, legacy badges first, the glow note and certificate links", () => {
    const html = renderToStaticMarkup(<JourneyPanel journey={normalizeJourney(PAYLOAD)} onShare={() => {}} />);
    expect(html).toContain("Operative");
    expect(html).toContain("2,350");
    expect(html).toContain("#3");
    expect(html.indexOf("Founding Operative")).toBeLessThan(html.indexOf("First Lecture"));
    expect(html).toContain("Founding Glow");
    expect(html).toContain('href="https://example.test/certificates/ASI-2026-BADGE-000012-K"');
    expect(html).toContain("Share");
  });
});

describe("JourneyWelcome", () => {
  it("opens when the server says show, and Continue dismisses it once", async () => {
    respond(PAYLOAD);
    const tree = await mountJourney();
    expect(apiClient.get).toHaveBeenCalledWith("/engagement/journey/");
    expect(tree.text()).toContain("Your journey so far");
    expect(dialogTurn("levelup")).toBe(false);
    expect(dialogTurn("handle")).toBe(false);
    await fire(tree.getByLabel("button", "Continue"), "onClick");
    expect(tree.text()).not.toContain("Your journey so far");
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith("/engagement/journey/dismiss/", {});
    expect(dialogTurn("handle")).toBe(true);
    expect(dialogTurn("levelup")).toBe(true);
  });

  it("Escape (the dialog closing) also dismisses, only once", async () => {
    respond(PAYLOAD);
    const tree = await mountJourney();
    const dialog = tree.find((node) => node.props?.["data-dialog"] === "true");
    await act(() => dialog.props.onOpenChange(false));
    expect(tree.text()).toBe("");
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when show is false and frees the queue", async () => {
    respond({ show: false, journey: null });
    const tree = await mountJourney();
    expect(tree.text()).toBe("");
    expect(dialogTurn("handle")).toBe(true);
  });

  it("renders nothing when engagement is off (403) or the request fails", async () => {
    apiClient.get.mockRejectedValue({ response: { status: 403, data: { code: "feature_disabled" } } });
    const tree = await mountJourney();
    expect(tree.text()).toBe("");
    expect(dialogTurn("levelup")).toBe(true);
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("never asks for staff or instructors", async () => {
    await mountJourney({ id: 1, role: "student", is_admin: true });
    await mountJourney({ id: 2, role: "instructor" });
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(dialogTurn("handle")).toBe(true);
  });
});

describe("share", () => {
  const journey = normalizeJourney(PAYLOAD);

  it("copies the link when there is no share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await shareJourney(journey, { clipboard: { writeText } })).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/u\/quiet_cipher$/));
  });

  it("uses the native share sheet when there is one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    expect(await shareJourney(journey, { share })).toBe("shared");
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: "My journey so far" }));
    const abort = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { name: "AbortError" }));
    expect(await shareJourney(journey, { share: abort })).toBe("cancelled");
    expect(await shareJourney(journey, {})).toBe("failed");
  });
});

describe("one dialog at a time", () => {
  it("orders journey, then handle prompt, then level-up", () => {
    expect(DIALOG_ORDER).toEqual(["journey", "handle", "levelup"]);
    holdDialog("journey");
    holdDialog("handle");
    expect(dialogTurn("journey")).toBe(true);
    expect(dialogTurn("handle")).toBe(false);
    expect(dialogTurn("levelup")).toBe(false);
    releaseDialog("journey");
    expect(dialogTurn("handle")).toBe(true);
    expect(dialogTurn("levelup")).toBe(false);
    releaseDialog("handle");
    expect(dialogTurn("levelup")).toBe(true);
  });
});

describe("Founding Glow frame", () => {
  const PROFILE = { handle: "quiet_cipher", header: { display_name: "Quiet Cipher" }, theme: {}, blocks: [] };
  const render = (profile) => renderToStaticMarkup(<StaticRouter location="/u/quiet_cipher"><ProfileView profile={profile} showReport={false} /></StaticRouter>);

  it("shows the golden-white glow with its name while it is on", () => {
    const html = render({ ...PROFILE, frame: { kind: "founding_glow", label: "Founding Glow", ends_at: "2026-12-31T00:00:00+05:30" } });
    expect(html).toContain('data-frame="founding_glow"');
    expect(html).toContain("Founding Glow");
    expect(html).not.toContain("mctf-aura");
  });

  it("is absent without a frame", () => {
    expect(render({ ...PROFILE, frame: null })).not.toContain("founding_glow");
    expect(render(PROFILE)).not.toContain("Founding Glow");
  });
});

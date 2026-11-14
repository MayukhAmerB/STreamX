// Frozen UI-overhaul contracts (plan Appendix A). The backend keeps a
// byte-identical copy (backend/apps/console_api/contract_fixtures/) and its
// tests compare the stub endpoints against it; these tests pin the
// vocabularies the Console relies on.
import { describe, expect, it } from "vitest";
import { applyCapabilities, TEACH_ITEM_KEYS } from "../../features/capabilities";
import attention from "./attention.json";
import capabilities from "./capabilities.json";
import errors from "./errors.json";
import features from "./features.json";
import search from "./search.json";
import today from "./today.json";

const STATES = ["enabled", "disabled", "hidden"];
const QUEUE_KEYS = [
  "enrolment_requests",
  "reports_to_grade",
  "recordings_to_review",
  "uploads_failed",
  "payments_to_action",
  "exams_to_publish",
  "leads",
  "flagged_content",
  "quarantined_files",
  "system_issues",
  "plans_awaiting_price",
];
const NEXT_UP_KINDS = ["live_now", "exam_open", "report_due", "resume", "next_class", "browse"];

describe("capabilities contract (A.1)", () => {
  it.each(Object.entries(capabilities))("%s uses the state vocabulary", (variant, caps) => {
    expect(Number.isInteger(caps.version)).toBe(true);
    expect(Object.keys(caps.workspaces)).toEqual(["learn", "teach", "admin"]);
    expect(Object.keys(caps.items)).toEqual([...TEACH_ITEM_KEYS]);
    for (const entry of [...Object.values(caps.workspaces), ...Object.values(caps.items)]) {
      expect(STATES).toContain(entry.state);
      expect("reason" in entry).toBe(entry.state === "disabled");
    }
    expect("status" in caps).toBe(variant.startsWith("staff"));
  });

  it("only staff while teaching is off see the switch status", () => {
    expect(capabilities.staff_off.status).toEqual([
      { key: "teaching", label: "Teachers section", enabled: false, manage_url: "/console/admin/settings/features" },
    ]);
    expect(capabilities.staff_on.status).toEqual([]);
  });

  it("drives nav items through applyCapabilities", () => {
    const items = [{ id: "home" }, { id: "teach-courses", capability: "teach-courses" }];
    expect(applyCapabilities(items, capabilities.instructor_off).map((item) => item.state)).toEqual(["enabled", "disabled"]);
    expect(applyCapabilities(items, capabilities.instructor_on).map((item) => item.state)).toEqual(["enabled", "enabled"]);
    expect(applyCapabilities(items, capabilities.student).map((item) => item.state)).toEqual(["enabled", "hidden"]);
  });
});

describe("today contract (A.2)", () => {
  it("uses the Next up vocabulary", () => {
    for (const variant of ["learn", "learn_browse"]) {
      expect(NEXT_UP_KINDS).toContain(today[variant].next_up.kind);
      expect(Object.keys(today[variant].next_up.action)).toEqual(["label", "href"]);
      expect(today[variant].teach).toBeNull();
    }
    today.learn.also.forEach((row) => expect(NEXT_UP_KINDS).toContain(row.kind));
    expect(today.teach.next_up).toBeNull();
    expect(Object.keys(today.teach.teach)).toEqual(["to_grade", "host_next", "recordings", "exams_open"]);
  });
});

describe("attention, search and features contracts (A.3)", () => {
  it.each(Object.entries(attention))("%s lists the queues in order", (_variant, payload) => {
    expect(payload.queues.map((queue) => queue.key)).toEqual(QUEUE_KEYS);
    payload.queues.forEach((queue) => {
      expect(["normal", "high"]).toContain(queue.severity);
      expect(Object.keys(queue)).toEqual(["key", "label", "count", "oldest_at", "severity", "href", "action_label"]);
    });
    expect(Object.keys(payload)).toEqual(["queues", "live_today", "switches", "generated_at"]);
  });

  it("search groups carry items with id, title, subtitle, href", () => {
    for (const group of search.pay.groups) {
      group.items.forEach((item) => expect(Object.keys(item)).toEqual(["id", "title", "subtitle", "href"]));
    }
    expect(search.short_query.groups).toEqual([]);
  });

  it("feature cards keep the agreed keys", () => {
    const keys = ["key", "label", "summary", "group", "enabled", "default", "locked", "version", "updated_by", "updated_at", "impact", "history"];
    expect(Object.keys(features.list[0])).toEqual(keys);
    expect(Object.keys(features.post_response)).toEqual(keys);
    expect(Object.keys(features.post_request)).toEqual(["enabled", "expected_version", "note", "reason"]);
  });

  it("errors use the project envelope with a stable code", () => {
    expect(errors.feature_disabled.code).toBe("feature_disabled");
    expect(errors.feature_disabled.errors.feature).toBe("teaching");
    expect(errors.feature_changed_meanwhile.code).toBe("feature_changed_meanwhile");
  });
});

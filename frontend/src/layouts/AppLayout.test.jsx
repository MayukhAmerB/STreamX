import { describe, expect, it } from "vitest";

import { isFridayWebsitePath } from "./AppLayout";

describe("hybrid release: which public pages are the Friday website", () => {
  it("is the landing page and the pages its navbar links to", () => {
    for (const path of ["/", "/courses", "/courses/", "/watch", "/about", "/national-desk", "/contact", "/faqs", "/as-accounts", "/join-alsyed", "/hall-of-fame", "/courses?view=live"]) {
      expect(isFridayWebsitePath(path), path).toBe(true);
    }
  });

  it("keeps every other public page on the latest (13ca6b79) surface", () => {
    for (const path of ["/courses/30", "/courses/30/payment", "/courses/30/register", "/login", "/reset-password", "/terms", "/pricing", "/monthly-ctf", "/certificates/ASI-1", "/u/night_owl", "/nope"]) {
      expect(isFridayWebsitePath(path), path).toBe(false);
    }
  });
});

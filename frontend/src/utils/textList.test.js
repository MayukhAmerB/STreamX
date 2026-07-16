import { describe, expect, it } from "vitest";

import { normalizeTextList } from "./textList";

describe("normalizeTextList", () => {
  it("preserves a correctly stored JSON list", () => {
    expect(normalizeTextList(["OSINT fundamentals", "domain intelligence"])).toEqual([
      "OSINT fundamentals",
      "domain intelligence",
    ]);
  });

  it("removes Python-list punctuation left in legacy array items", () => {
    expect(
      normalizeTextList([
        "['OSINT fundamentals'",
        "'search engine intelligence'",
        "'domain intelligence']",
      ])
    ).toEqual(["OSINT fundamentals", "search engine intelligence", "domain intelligence"]);
  });

  it("normalizes a legacy string representation", () => {
    expect(normalizeTextList("['social media investigation', 'image verification']")).toEqual([
      "social media investigation",
      "image verification",
    ]);
  });
});

import { describe, expect, it } from "vitest";

import {
  ALL_CLUES,
  allToolCount,
  CLUE_FILTERS,
  countTools,
  filterToolGroups,
  getCategory,
  toolCategories,
  toSentenceCase,
} from "./osintLibrary";

describe("OSINT tools library model", () => {
  it("keeps every category and tool from the original library", () => {
    expect(toolCategories).toHaveLength(10);
    expect(allToolCount).toBe(72);
    expect(countTools(filterToolGroups())).toBe(72);
  });

  it("offers one clue filter per category, beginner lanes first and 'Not sure yet' last", () => {
    expect(CLUE_FILTERS).toHaveLength(toolCategories.length);
    expect(new Set(CLUE_FILTERS.map((clue) => clue.categoryTitle)).size).toBe(toolCategories.length);
    expect(new Set(CLUE_FILTERS.map((clue) => clue.id)).size).toBe(CLUE_FILTERS.length);
    expect(CLUE_FILTERS[0]).toMatchObject({ id: "username-or-email", label: "Username or email" });
    expect(CLUE_FILTERS.at(-1)).toMatchObject({
      label: "Not sure yet",
      categoryTitle: "Directories And Search Starting Points",
    });
    expect(CLUE_FILTERS.find((clue) => clue.label === "Threat platforms")?.categoryTitle).toBe(
      "Enterprise OSINT And Threat Platforms"
    );
    for (const clue of CLUE_FILTERS) {
      expect(getCategory(clue.categoryTitle)).toBeTruthy();
      expect(clue.label.length).toBeLessThanOrEqual(20);
    }
  });

  it("filters by clue", () => {
    const groups = filterToolGroups({ clueId: "phone-or-vehicle" });
    expect(groups).toHaveLength(1);
    expect(groups[0].category.title).toBe("Phone And Vehicle Lookups");
    expect(groups[0].tools).toHaveLength(4);
    // Unknown clue ids fall back to everything.
    expect(countTools(filterToolGroups({ clueId: "nope" }))).toBe(72);
  });

  it("searches names, types, descriptions and category titles (all words must match)", () => {
    const byName = filterToolGroups({ query: "  spiderfoot " });
    expect(countTools(byName)).toBe(1);
    expect(byName[0].tools[0].name).toBe("SpiderFoot");

    const byCategory = filterToolGroups({ query: "metadata" });
    expect(byCategory.map((group) => group.category.title)).toContain("Metadata Analysis");

    const twoWords = filterToolGroups({ query: "maltego timeline" });
    expect(twoWords.flatMap((group) => group.tools.map((tool) => tool.name))).toEqual(["Maltego timeline graphs"]);

    expect(filterToolGroups({ query: "zzzz-no-such-tool" })).toEqual([]);
    expect(filterToolGroups({ clueId: "phone-or-vehicle", query: "maltego" })).toEqual([]);
    expect(countTools(filterToolGroups({ clueId: ALL_CLUES, query: "" }))).toBe(72);
  });

  it("formats category titles in sentence case and keeps acronyms", () => {
    expect(toSentenceCase("Enterprise OSINT And Threat Platforms")).toBe("Enterprise OSINT and threat platforms");
    expect(toSentenceCase("Username, Email And Identity Correlation")).toBe("Username, email and identity correlation");
    expect(filterToolGroups({ clueId: "domain-or-url" })[0].title).toBe("Domain, email and internet infrastructure");
  });
});

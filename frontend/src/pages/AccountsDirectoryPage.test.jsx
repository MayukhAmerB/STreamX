import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AccountsDirectoryContent, normalizeAccountDirectory } from "./AccountsDirectoryPage";

const categories = [
  {
    id: 1,
    name: "Instagram",
    slug: "instagram",
    icon_key: "instagram",
    description: "Verified profiles.",
    accounts: [
      {
        id: 10,
        account_name: "Al Syed Initiative",
        handle: "@alsyedinitiative",
        url: "https://instagram.com/alsyedinitiative",
        managed_by: "Al Syed team",
        status_label: "Active",
      },
    ],
  },
  {
    id: 2,
    name: "YouTube",
    slug: "youtube",
    icon_key: "youtube",
    accounts: [
      {
        id: 11,
        account_name: "Al Syed Learning",
        handle: "@alsyedlearning",
        url: "https://youtube.com/@alsyedlearning",
        managed_by: "Education team",
        status_label: "Active",
      },
    ],
  },
  {
    id: 3,
    name: "X",
    slug: "x",
    icon_key: "x",
    accounts: [],
  },
];

describe("AccountsDirectoryPage", () => {
  it("renders Instagram first with coherent category and account numbering", () => {
    const html = renderToStaticMarkup(<AccountsDirectoryContent categories={categories} />);

    expect(html).toContain("Official presence,");
    expect(html).toContain("Primary verification channel");
    expect(html).toContain("Account name");
    expect(html).toContain("Al Syed Initiative");
    expect(html).toContain("@alsyedinitiative");
    expect(html).toContain("Al Syed team");
    expect(html).toContain('href="https://instagram.com/alsyedinitiative"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html.indexOf("Instagram accounts")).toBeLessThan(html.indexOf("YouTube accounts"));
    expect(html.match(/class="as-account-index">01/g)).toHaveLength(1);
    expect(html.match(/class="as-account-index">02/g)).toHaveLength(1);
    expect(html).toContain("Search the directory");
    expect(html).toContain("No accounts published yet");
  });

  it("normalizes malformed API values and supports the retry state", () => {
    expect(normalizeAccountDirectory(null)).toEqual([]);
    expect(normalizeAccountDirectory([{ id: 1 }, ...categories])).toEqual(categories);

    const retry = vi.fn();
    const html = renderToStaticMarkup(
      <AccountsDirectoryContent categories={[]} error="Unavailable" onRetry={retry} />
    );
    expect(html).toContain("Directory temporarily unavailable");
    expect(html).toContain("Try again");
  });
});

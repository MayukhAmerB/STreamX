// The old hub module now serves the "Next up" Home (WS-C); detailed tests
// live in features/console-home/home.test.jsx.
import { describe, expect, it } from "vitest";

import HomePage from "../features/console-home/HomePage";
import HomeView from "../features/console-home/HomeView";
import UsersCornerPage, { UsersCornerView } from "./UsersCornerPage";

describe("UsersCornerPage", () => {
  it("is the Console Home", () => {
    expect(UsersCornerPage).toBe(HomePage);
    expect(UsersCornerView).toBe(HomeView);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DetailsStep,
  JoinStepper,
  RoleStep,
  SubmittedStep,
  buildJoinPayload,
  isDetailsComplete,
  isValidIndianMobile,
  normalizeLocations,
  pickInstagramUrl,
} from "./JoinAlSyedPage";

const noop = () => {};

const locations = [
  { state: "Kerala", districts: ["Ernakulam", "Kollam"] },
  { state: "West Bengal", districts: ["Howrah", "Kolkata"] },
];

const completeForm = {
  role: "lawyer",
  full_name: "  Ayesha Khan ",
  age: "29",
  phone_number: "9876543210",
  address: " Park Circus ",
  state: "West Bengal",
  district: "Kolkata",
  terms_accepted: true,
};

describe("JoinAlSyedPage", () => {
  it("renders both roles and keeps continue disabled until one is chosen", () => {
    const html = renderToStaticMarkup(<RoleStep role="" onSelect={noop} onContinue={noop} onBack={noop} />);

    expect(html).toContain("Join Al Syed");
    expect(html).toContain("Citizen / Volunteer");
    expect(html).toContain("Lawyer");
    expect(html).toMatch(/<button type="submit" class="join-continue" disabled=""/);
  });

  it("marks completed and current steps in the stepper", () => {
    const html = renderToStaticMarkup(<JoinStepper current="details" />);

    expect(html).toContain("join-step--done");
    expect(html).toContain('join-step--current" aria-current="step"');
    expect(html).toContain("join-step--upcoming");
  });

  it("shows only the districts of the selected state with a fixed +91 code", () => {
    const html = renderToStaticMarkup(
      <DetailsStep
        form={{ ...completeForm, district: "" }}
        locations={locations}
        onField={noop}
        onOpenTerms={noop}
        onSubmit={noop}
        onBack={noop}
      />,
    );

    expect(html).toContain("+91");
    expect(html).toContain(">Kolkata</option>");
    expect(html).not.toContain(">Ernakulam</option>");
    expect(html).toContain("Terms and Conditions.");
  });

  it("validates details and builds an API payload", () => {
    expect(isValidIndianMobile("9876543210")).toBe(true);
    expect(isValidIndianMobile("5876543210")).toBe(false);
    expect(isDetailsComplete(completeForm)).toBe(true);
    expect(isDetailsComplete({ ...completeForm, terms_accepted: false })).toBe(false);
    expect(isDetailsComplete({ ...completeForm, age: "15" })).toBe(false);
    expect(isDetailsComplete({ ...completeForm, age: "" })).toBe(true);

    expect(buildJoinPayload(completeForm)).toEqual({
      role: "lawyer",
      full_name: "Ayesha Khan",
      age: 29,
      phone_number: "+919876543210",
      address: "Park Circus",
      state: "West Bengal",
      district: "Kolkata",
      terms_accepted: true,
    });
    expect(buildJoinPayload({ ...completeForm, age: "" }).age).toBeNull();
  });

  it("normalises location payloads and picks the Instagram link from AS Accounts", () => {
    expect(normalizeLocations([{ state: "Goa", districts: ["North Goa", 4] }, null, { state: 3 }])).toEqual([
      { state: "Goa", districts: ["North Goa"] },
    ]);
    expect(
      pickInstagramUrl([
        { slug: "youtube", accounts: [{ url: "https://youtube.com/x" }] },
        { slug: "instagram", accounts: [{ url: "https://instagram.com/alsyed" }] },
      ]),
    ).toBe("https://instagram.com/alsyed");
    expect(pickInstagramUrl([])).toContain("instagram.com");
  });

  it("renders the submitted screen with the updates link", () => {
    const html = renderToStaticMarkup(<SubmittedStep instagramUrl="https://instagram.com/alsyed" />);

    expect(html).toContain("Form Submitted");
    expect(html).toContain("<strong>Team Al Syed</strong>");
    expect(html).toContain('href="https://instagram.com/alsyed"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Get the Updates");
  });
});

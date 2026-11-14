import { describe, expect, it } from "vitest";

import { clientTargetKey } from "./targetKey";
import { findExistingTarget } from "./weeklyModel";

// The same vectors as EQUIVALENCE_CLASSES in
// backend/tests/test_textnorm_target_keys.py: the client mirror must give the
// server's key for each (key -> ways of writing that one target).
const EQUIVALENCE_CLASSES = {
  "acme": [
    "Acme",
    "acme",
    "ACME",
    "  Acme  ",
    "Acme Pvt Ltd",
    "Acme Pvt. Ltd.",
    "ACME Private Limited",
    "Acme (OPC) Private Limited",
    "Acme Ltd",
    "Acme Limited",
    "Acme, Inc.",
    "Acme Inc",
    "Acme Incorporated",
    "Acme LLC",
    "Acme L.L.C.",
    "Acme LLP",
    "Acme Corp.",
    "Acme Corporation",
    "Acme Co.",
    "Acme & Co.",
    "Acme and Company",
    "Acme GmbH",
    "Acme AG",
    "Acme S.A.",
    "Acme B.V.",
    "Acme PLC",
    "Acme Pte. Ltd.",
    "Acme Sdn. Bhd.",
    "Acme Pty Ltd",
    "Acme Group",
    "Acme Holdings Ltd",
    "Acme International",
    "The Acme Company",
    "M/s Acme Pvt Ltd",
    "M/s. Acme",
    "ＡＣＭＥ",
    "Acme\u200b",
    "\u202eAcme",
    "acme\tpvt\nltd",
    "\"Acme\"",
    "«Acme»",
    "Acme.",
    "acme!",
  ],
  "tata consultancy services": [
    "Tata Consultancy Services",
    "TATA CONSULTANCY SERVICES LIMITED",
    "Tata  Consultancy   Services Ltd.",
    "tata-consultancy-services",
    "Tata_Consultancy_Services",
  ],
  "cafe coffee day": [
    "Café Coffee Day",
    "CAFE COFFEE DAY",
    "Cafe\u0301 Coffee Day",
    "Café Coffee Day Pvt Ltd",
  ],
  "jp morgan": [
    "J.P. Morgan",
    "JP Morgan",
    "J. P. Morgan",
    "jp morgan",
    "J.P. Morgan Inc.",
  ],
  "johnson and johnson": [
    "Johnson & Johnson",
    "Johnson and Johnson",
    "JOHNSON & JOHNSON PVT LTD",
    "Johnson+Johnson",
  ],
  "mcdonalds": [
    "McDonald's",
    "McDonald’s",
    "MCDONALDS",
    "McDonalds Corporation",
  ],
  "the company": [
    "The Company",
    "the company",
    "THE COMPANY",
  ],
  "company watch": [
    "Company Watch",
    "company watch ltd",
  ],
  "limited edition labs": [
    "Limited Edition Labs",
    "Limited Edition Labs Pvt Ltd",
  ],
  "123 industries": [
    "123 Industries Pvt Ltd",
    "123 INDUSTRIES",
  ],
  "elon musk": [
    "Elon Musk",
    "elon  musk",
    "ELON MUSK",
  ],
  "imran khan": [
    "Imran Khan",
    "imran khan",
  ],
  "عمران خان": [
    "عمران خان",
    "ع\u0650مران خان",
  ],
  "ac dc": [
    "AC/DC",
    "ac-dc",
    "AC DC",
  ],
  "acme.com": [
    "acme.com",
    "ACME.COM",
    "www.acme.com",
    "acme.com.",
    "https://www.acme.com/",
    "http://acme.com",
    "HTTPS://ACME.COM:443/en/contact?utm_source=x#top",
    "https://acme.com/about-us",
    "https://www.acme.com/index.html",
    "acme.com/careers/",
    "<https://acme.com>",
    "hxxps://acme.com/",
    "https://user:pass@acme.com/",
  ],
  "acme.org": [
    "acme.org",
    "https://www.acme.org/about",
  ],
  "acme.io": [
    "acme.io",
    "https://acme.io/",
  ],
  "acme.co.in": [
    "acme.co.in",
    "http://acme.co.in/about-us",
    "www.acme.co.in",
  ],
  "acme.in": [
    "acme.in",
    "https://acme.in/",
  ],
  "shop.acme.com": [
    "shop.acme.com",
    "https://shop.acme.com/products",
  ],
  "acme-labs.com": [
    "acme-labs.com",
    "https://www.Acme-Labs.com/",
  ],
  "münchen.de": [
    "münchen.de",
    "xn--mnchen-3ya.de",
    "https://xn--mnchen-3ya.de/",
  ],
  "john.tumblr.com": [
    "john.tumblr.com",
    "https://john.tumblr.com/post/1",
  ],
  "example.edu/~alice": [
    "example.edu/~alice",
    "https://www.example.edu/~alice/",
  ],
  "example.edu/~bob": [
    "example.edu/~bob",
  ],
  "example.org/alice": [
    "example.org/alice",
    "https://example.org/en/alice",
  ],
  "facebook.com": [
    "facebook.com",
    "https://www.facebook.com/",
    "fb.com",
  ],
  "facebook.com/john": [
    "facebook.com/john",
    "https://www.facebook.com/John/",
    "https://m.facebook.com/john?ref=bookmarks",
    "fb.com/john",
    "https://web.facebook.com/john/about",
    "https://www.facebook.com/john/posts/12345",
    "facebook.com/john#photos",
  ],
  "facebook.com/jane": [
    "facebook.com/jane",
    "https://facebook.com/Jane",
  ],
  "facebook.com/profile.php?id=123": [
    "facebook.com/profile.php?id=123",
    "https://m.facebook.com/profile.php?id=123#about",
    "https://www.facebook.com/profile.php?sk=about&id=123",
  ],
  "facebook.com/profile.php?id=456": [
    "https://www.facebook.com/profile.php?id=456",
  ],
  "facebook.com/groups/osint-india": [
    "https://www.facebook.com/groups/osint-india/members",
  ],
  "x.com/elonmusk": [
    "x.com/elonmusk",
    "twitter.com/elonmusk",
    "https://twitter.com/ElonMusk",
    "https://mobile.twitter.com/elonmusk?lang=en",
    "https://x.com/elonmusk/status/123456?s=20",
  ],
  "x.com/jack": [
    "https://x.com/jack",
  ],
  "linkedin.com/in/john-doe": [
    "linkedin.com/in/john-doe",
    "https://www.linkedin.com/in/john-doe/",
    "https://in.linkedin.com/in/John-Doe/details/experience/",
  ],
  "linkedin.com/company/acme": [
    "https://www.linkedin.com/company/acme/about/",
  ],
  "instagram.com/acme": [
    "instagram.com/acme",
    "https://www.instagram.com/acme/?igshid=abc",
    "instagr.am/acme",
  ],
  "instagram.com/p/cxyz": [
    "https://www.instagram.com/p/Cxyz/",
  ],
  "github.com/torvalds": [
    "github.com/torvalds",
    "https://github.com/Torvalds",
  ],
  "github.com/torvalds/linux": [
    "github.com/torvalds/linux",
    "https://github.com/torvalds/linux/tree/master/kernel",
  ],
  "github.com/torvalds/subsurface": [
    "https://github.com/torvalds/subsurface",
  ],
  "reddit.com/r/osint": [
    "https://www.reddit.com/r/OSINT/",
    "reddit.com/r/osint/top",
  ],
  "reddit.com/u/osint": [
    "https://old.reddit.com/u/osint",
  ],
  "t.me/durov": [
    "t.me/durov",
    "https://telegram.me/durov",
  ],
  "youtube.com/watch?v=dQw4w9WgXcQ": [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=tracking",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
  ],
  "youtube.com/watch?v=DQW4W9WGXCQ": [
    "https://www.youtube.com/watch?v=DQW4W9WGXCQ",
  ],
  "youtube.com/@mrbeast": [
    "youtube.com/@MrBeast",
    "https://www.youtube.com/@mrbeast/videos",
  ],
  "youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA": [
    "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/about",
  ],
  "play.google.com/store/apps/details?id=com.whatsapp": [
    "https://play.google.com/store/apps/details?id=com.whatsapp&hl=en_IN",
  ],
  "@acme_hq": [
    "@acme_hq",
    "@Acme_HQ",
    "@ACME_HQ.",
  ],
  "@acmehq": [
    "@acmehq",
  ],
  "@john.doe": [
    "@john.doe",
    "@John.Doe",
  ],
  "john@acme.com": [
    "john@acme.com",
    "John@ACME.com",
    "mailto:john@acme.com",
  ],
  "jane@acme.com": [
    "jane@acme.com",
  ],
  "john@acme.org": [
    "john@acme.org",
  ],
  "192.168.1.1": [
    "192.168.1.1",
    "http://192.168.1.1:8080/admin",
    "https://192.168.1.1/",
  ],
  "192.168.1.2": [
    "192.168.1.2",
  ],
  "10.0.0.0/8": [
    "10.0.0.0/8",
    "10.1.2.3/8",
  ],
  "2001:db8::1": [
    "2001:db8::1",
    "2001:DB8:0:0:0:0:0:1",
    "[2001:db8::1]",
    "http://[2001:db8::1]:8080/",
  ],
};

const NOT_A_TARGET = ["", "   ", "!!!", "---", "\u200b", "@", "...", "“”"];

describe("clientTargetKey mirrors apps.core.textnorm.target_key", () => {
  const rows = Object.entries(EQUIVALENCE_CLASSES).flatMap(([key, values]) => values.map((value) => [value, key]));

  it.each(rows)("%j -> %j", (value, key) => {
    expect(clientTargetKey(value)).toBe(key);
  });

  it("never gives two different targets one key", () => {
    const owner = new Map();
    for (const [value, key] of rows) {
      const got = clientTargetKey(value);
      if (owner.has(got)) expect(owner.get(got)).toBe(key);
      owner.set(got, key);
    }
  });

  it.each(NOT_A_TARGET)("%j is not a target", (value) => {
    expect(clientTargetKey(value)).toBe("");
  });
});

describe("findExistingTarget only flags true duplicates", () => {
  const targets = [
    { id: 1, target_name: "Acme Pvt Ltd" },
    { id: 2, target_name: "facebook.com/john" },
    { id: 3, target_name: "192.168.1.1" },
  ];

  it.each([
    ["acme", 1],
    ["ACME Private Limited", 1],
    ["https://m.facebook.com/John/?ref=bookmarks", 2],
    ["http://192.168.1.1:8080/", 3],
  ])("%s is the existing target %i", (name, id) => {
    expect(findExistingTarget(name, targets)?.id).toBe(id);
  });

  it.each(["acme.com", "acme.org", "facebook.com/jane", "192.168.1.2", "@acme", "john@acme.com"])(
    "%s is a different target (the server may still warn that it is similar)",
    (name) => {
      expect(findExistingTarget(name, targets)).toBeNull();
    }
  );
});

const requestedBrand = String(import.meta.env.VITE_SITE_BRAND || "alsyed").trim().toLowerCase();

const brands = {
  alsyed: {
    id: "alsyed",
    name: "Al syed Initiative",
    platformLabel: "Cybersecurity Platform",
    documentTitle: "Al syed Initiative | Live OSINT Training, Labs & CTF",
    footerDescription:
      "Live OSINT training: real cases, marked reports and certificates anyone can verify. Founded by cyber activist Al Syed under the ADL Front.",
    footerKicker: "Public sources. Lawful use.",
    siteOrigin: "https://alsyedinitiative.com",
    description:
      "Live OSINT classes every Fri, Sat and Sun, weekly marked reports, real investigation labs and certificates anyone can verify. Start free; Pentesting coming soon.",
    youtube: true,
  },
  owlcognito: {
    id: "owlcognito",
    name: "OwlCognito",
    platformLabel: "Intelligence Learning Platform",
    documentTitle: "OwlCognito | Intelligence Training",
    footerDescription:
      "A private intelligence learning environment with structured courses, live instruction, and practical research workflows.",
    footerKicker: "Private learning access",
    siteOrigin: "",
    description:
      "A private intelligence learning platform with structured courses, live instruction and practical research workflows.",
    youtube: false,
  },
};

const baseBrand = brands[requestedBrand] || brands.alsyed;

/** "on"/"off" (or true/false, 1/0) overrides the brand default; anything else keeps it. */
function readToggle(value, fallback) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(text)) return true;
  if (["0", "false", "off", "no"].includes(text)) return false;
  return fallback;
}

export const siteBrand = {
  ...baseBrand,
  // The YouTube section is the Al Syed channel: off for other brands unless configured.
  youtube: readToggle(import.meta.env.VITE_SITE_YOUTUBE, baseBrand.youtube),
};

export function brandText(alsyedText, owlcognitoText) {
  return siteBrand.id === "owlcognito" ? owlcognitoText : alsyedText;
}

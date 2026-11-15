const requestedBrand = String(import.meta.env.VITE_SITE_BRAND || "alsyed").trim().toLowerCase();

const brands = {
  alsyed: {
    id: "alsyed",
    name: "Al syed Initiative",
    platformLabel: "Cybersecurity Platform",
    documentTitle: "Al syed Initiative | Cybersecurity Training",
    footerDescription:
      "Enterprise-focused cybersecurity learning with structured courses, live classes, and practical workflow training.",
    footerKicker: "Controlled learning access",
    siteOrigin: "https://alsyedinitiative.com",
    description:
      "Practical OSINT and web application penetration testing training with live classes, protected recordings, mentor support and verified certificates.",
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

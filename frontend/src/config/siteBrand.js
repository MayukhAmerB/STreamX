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
  },
  owlcognito: {
    id: "owlcognito",
    name: "OwlCognito",
    platformLabel: "Intelligence Learning Platform",
    documentTitle: "OwlCognito | Intelligence Training",
    footerDescription:
      "A private intelligence learning environment with structured courses, live instruction, and practical research workflows.",
    footerKicker: "Private learning access",
  },
};

export const siteBrand = brands[requestedBrand] || brands.alsyed;

export function brandText(alsyedText, owlcognitoText) {
  return siteBrand.id === "owlcognito" ? owlcognitoText : alsyedText;
}

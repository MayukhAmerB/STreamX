// Certificate page, reference numbers and PDF/web layout parity. OWNER: WS-CERTIFICATES.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderTree } from "../../test-utils/renderTree";

const api = vi.hoisted(() => ({
  fetchCertificate: vi.fn(),
  certificateErrorKind: (error) => {
    const status = error?.response?.status;
    const code = error?.response?.data?.code;
    if (status === 404) return "missing";
    if (status === 400 && code === "certificate_reference_typo") return "typo";
    if (status === 400) return "invalid";
    if (status === 429) return "busy";
    return "error";
  },
}));
vi.mock("./certificateApi", () => api);

import LAYOUT from "./certificateLayout.json";
import CertificatePage from "./CertificatePage";
import { ALPHABET, checkCharacter, formatReference, parseReference } from "./reference";
import { certificatePublicRoutes } from "./routes";
import VerifyCertificateForm from "./VerifyCertificateForm";

// Made by the backend (apps.engagement.certificates.format_reference(2026, "OSINT", 42)).
const BACKEND_REFERENCE = "ASI-2026-OSINT-000042-L";
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));

function certificate(overrides = {}) {
  const reference = overrides.reference || BACKEND_REFERENCE;
  const valid = overrides.valid ?? true;
  return {
    reference,
    status: valid ? "verified" : "revoked",
    valid,
    type: "OSINT",
    type_label: "Open Source Intelligence",
    recipient_name: "Asha Kumar",
    heading: "Certificate of Completion",
    statement: "has successfully completed the course",
    title: "OSINT Batch 7",
    programme: "Open Source Intelligence programme · Batch B7",
    issued_at: "2026-11-15T10:00:00+05:30",
    issued_on: "2026-11-15",
    issuer: { name: "Al Syed Initiative", signatory: "Al Syed Initiative" },
    revision: 1,
    revoked_at: valid ? null : "2026-11-20T10:00:00+05:30",
    verify_url: `https://alsyedinitiative.com/certificates/${reference}`,
    verify_short_url: `alsyedinitiative.com/certificates/${reference}`,
    linkedin_add_url: `https://www.linkedin.com/profile/add?startTask=CERTIFICATION_NAME&certId=${reference}`,
    pdf_url: `https://alsyedinitiative.com/api/engagement/certificates/${reference}/certificate.pdf?v=1v`,
    image_url: `https://alsyedinitiative.com/api/engagement/certificates/${reference}/certificate.png?v=1v`,
    og_image_url: `https://alsyedinitiative.com/api/engagement/certificates/${reference}/preview.png?v=1v`,
    print: {
      texts: {
        monogram: "ASI",
        kicker: "OPEN SOURCE INTELLIGENCE",
        heading: "Certificate of Completion",
        name: "Asha Kumar",
        title: "OSINT Batch 7",
        dateValue: "15 November 2026",
        referenceValue: reference,
        sealTop: valid ? "VERIFIED" : "REVOKED",
        footer: `Verify this certificate at alsyedinitiative.com/certificates/${reference}`,
      },
      sizes: { name: 50, heading: 44 },
      stamp: valid ? null : "REVOKED",
    },
    qr: { modules: 21, quiet: 2, path: "M0 0h7v1h-7zM0 6h7v1h-7z", url: `https://alsyedinitiative.com/certificates/${reference}` },
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

let tree;
async function mount(url, element = <CertificatePage />) {
  tree = await renderTree(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/certificates" element={element} />
        <Route path="/certificates/:reference" element={element} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
  await flush();
  await flush();
  return tree;
}

const pathname = (page) => page.find((node) => node.props?.["data-testid"] === "location")?.children?.[0]?.text;

describe("reference numbers", () => {
  it("agrees with the backend's check character", () => {
    expect(formatReference(2026, "OSINT", 42)).toBe(BACKEND_REFERENCE);
    expect(checkCharacter("ASI-2026-OSINT-000042")).toBe("L");
    expect(parseReference(BACKEND_REFERENCE)).toEqual({ ok: true, reference: BACKEND_REFERENCE });
  });

  it("catches every single-character typo", () => {
    for (let index = 0; index < BACKEND_REFERENCE.length; index += 1) {
      if (BACKEND_REFERENCE[index] === "-") continue;
      for (const char of ALPHABET) {
        if (char === BACKEND_REFERENCE[index]) continue;
        const typo = BACKEND_REFERENCE.slice(0, index) + char + BACKEND_REFERENCE.slice(index + 1);
        const parsed = parseReference(typo);
        // Caught, or a look-alike digit (Z for 2) read back as the very same reference: never another one.
        expect(!parsed.ok || parsed.reference === BACKEND_REFERENCE, typo).toBe(true);
        if (!"OQDILZSB".includes(char)) expect(parsed.ok, typo).toBe(false);
      }
    }
  });

  it("forgives case, spaces, missing dashes and look-alike digits", () => {
    for (const typed of [BACKEND_REFERENCE.toLowerCase(), " ASI 2026 OSINT 000042 L ", "ASI2026OSINT000042L", "ASI-2026-OSINT-OOOO42-L"]) {
      expect(parseReference(typed)).toEqual({ ok: true, reference: BACKEND_REFERENCE });
    }
    expect(parseReference("")).toEqual({ ok: false, reason: "empty" });
    expect(parseReference("hello")).toEqual({ ok: false, reason: "format" });
    expect(parseReference("ASI-2026-NOPE-000042-L").reason).toBe("format");
    expect(parseReference("ASI-2026-OSINT-000042-M")).toEqual({ ok: false, reason: "check" });
  });
});

describe("layout parity with the PDF", () => {
  it("uses an exact copy of the backend layout", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const backend = path.resolve(here, "../../../../backend/apps/engagement/certificate_layout.json");
    if (!fs.existsSync(backend)) return; // frontend-only checkout (Docker build context)
    expect(LAYOUT).toEqual(JSON.parse(fs.readFileSync(backend, "utf8")));
  });

  it("keeps every colour inside the palette law", () => {
    const lawful = /^#(?:([0-9a-f])\1\1|([0-9a-f]{2})\2\2|f3e2b3|e6d29c|f8edcf)$/i;
    for (const value of Object.values(LAYOUT.colors)) {
      const grey = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
      const isGrey = grey && Math.max(...grey.slice(1).map((h) => parseInt(h, 16))) - Math.min(...grey.slice(1).map((h) => parseInt(h, 16))) <= 3;
      expect(isGrey || lawful.test(value), value).toBe(true);
    }
  });
});

describe("certificate page", () => {
  beforeEach(() => {
    api.fetchCertificate.mockReset();
  });
  afterEach(async () => {
    await tree?.unmount?.();
    tree = null;
  });

  it("shows a verified certificate with downloads and LinkedIn", async () => {
    api.fetchCertificate.mockResolvedValue(certificate());
    const page = await mount(`/certificates/${BACKEND_REFERENCE}`);
    expect(api.fetchCertificate).toHaveBeenCalledWith(BACKEND_REFERENCE);
    const words = page.text();
    expect(words).toContain("Verified");
    expect(words).toContain("This certificate is genuine");
    expect(words).toContain("Asha Kumar");
    expect(words).toContain(BACKEND_REFERENCE);
    const artwork = page.find((node) => node.type === "figure");
    expect(artwork.props["aria-label"]).toContain(BACKEND_REFERENCE);
    const printedRef = page.find((node) => node.props?.["data-part"] === "referenceValue");
    expect(printedRef.children[0].text).toBe(BACKEND_REFERENCE);
    expect(page.find((node) => node.props?.["data-part"] === "name").props.style.fontSize).toBe("calc(var(--cv-u) * 50)");
    const links = page.all((node) => node.type === "a").map((node) => node.props.href);
    expect(links.some((href) => href.endsWith("certificate.pdf?v=1v"))).toBe(true);
    expect(links.some((href) => href.includes("certificate.png?v=1v&download=1"))).toBe(true);
    expect(links.some((href) => href.startsWith("https://www.linkedin.com/profile/add"))).toBe(true);
    expect(page.find((node) => node.props?.["data-part"] === "stamp")).toBeFalsy();
    // The QR code comes from the server as an SVG path: drawn monochrome, where the PDF has it.
    const qr = page.find((node) => node.props?.["data-part"] === "qr");
    expect(qr.type).toBe("svg");
    expect(qr.props.viewBox).toBe("-2 -2 25 25");
    expect(qr.props["aria-label"]).toContain(`/certificates/${BACKEND_REFERENCE}`);
    expect(qr.props.style.left).toBe(`calc(var(--cv-u) * ${LAYOUT.qr.cx})`);
    const path = qr.children.find((node) => node.type === "path");
    expect(path.props.d).toBe("M0 0h7v1h-7zM0 6h7v1h-7z");
    expect(path.props.fill).toBe(LAYOUT.colors[LAYOUT.qr.color]);
  });

  it("shows a revoked certificate clearly, without the LinkedIn button", async () => {
    api.fetchCertificate.mockResolvedValue(certificate({ valid: false }));
    const page = await mount(`/certificates/${BACKEND_REFERENCE}`);
    const words = page.text();
    expect(words).toContain("Revoked");
    expect(words).toContain("This certificate was revoked");
    expect(page.find((node) => node.props?.["data-part"] === "stamp")).toBeTruthy();
    expect(page.all((node) => String(node.props?.href || "").includes("linkedin.com")).length).toBe(0);
  });

  it("replaces a slug with the canonical reference", async () => {
    api.fetchCertificate.mockResolvedValue(certificate());
    const page = await mount("/certificates/Zx81kQ2mT0aBcDeFgHiJkL");
    await flush();
    expect(pathname(page)).toBe(`/certificates/${BACKEND_REFERENCE}`);
    expect(api.fetchCertificate).toHaveBeenCalledTimes(1);
    expect(page.text()).toContain("This certificate is genuine");
  });

  it("explains a mistyped reference without asking the server", async () => {
    const page = await mount("/certificates/ASI-2026-OSINT-000042-M");
    expect(api.fetchCertificate).not.toHaveBeenCalled();
    expect(page.text()).toContain("This reference number has a typo");
    expect(page.text()).toContain("Not verified");
  });

  it("says when no certificate has the number", async () => {
    api.fetchCertificate.mockRejectedValue({ response: { status: 404, data: { code: "certificate_not_found" } } });
    const page = await mount(`/certificates/${formatReference(2026, "PEN", 999)}`);
    expect(page.text()).toContain("No certificate has this reference number");
  });

  it("renders through the registered lazy routes", async () => {
    api.fetchCertificate.mockResolvedValue(certificate());
    tree = await renderTree(
      <MemoryRouter initialEntries={["/certificates"]}>
        <Suspense fallback={<p>loading</p>}>
          <Routes>{certificatePublicRoutes()}</Routes>
        </Suspense>
      </MemoryRouter>
    );
    for (let index = 0; index < 20 && !tree.text().includes("Verify a certificate"); index += 1) await flush();
    expect(tree.text()).toContain("Verify a certificate");
    expect(tree.find((node) => node.type === "input" && node.props?.name === "reference")).toBeTruthy();
  });
});

describe("verify form", () => {
  afterEach(async () => {
    await tree?.unmount?.();
    tree = null;
  });

  const submit = async (page, value) => {
    const input = page.find((node) => node.type === "input" && node.props?.name === "reference");
    await act(async () => input.props.onChange({ target: { value } }));
    await act(async () => page.find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }));
    await flush();
  };

  it("rejects a typo with an alert and opens a valid reference", async () => {
    const page = await mount("/certificates", <VerifyCertificateForm />);
    await submit(page, "asi 2026 osint 000042 m");
    expect(page.find((node) => node.props?.role === "alert").children[0]?.text).toContain("typo");
    expect(page.find((node) => node.type === "input").props["aria-invalid"]).toBe("true");
    expect(pathname(page)).toBe("/certificates");
    await submit(page, "asi 2026 osint 000042 l");
    expect(pathname(page)).toBe(`/certificates/${BACKEND_REFERENCE}`);
  });
});

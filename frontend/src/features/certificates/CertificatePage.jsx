// Public certificate page. OWNER: WS-CERTIFICATES.
//   /certificates                 the "Verify a certificate" form
//   /certificates/:reference      the certificate itself (a slug or a loose spelling is
//                                 replaced by the canonical reference number)
// No sign-in needed to VERIFY. Certificates are private: the full certificate (name,
// artwork, PDF/PNG) is shown only to the signed-in holder and to staff (the API sends
// `full: true`); everyone else sees the minimal "Verified" card (`full: false`).
// It keeps working when the engagement switch is off, because the API does.
import "./certificates.css";

import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import CertificateArtwork from "./CertificateArtwork";
import { certificateErrorKind, fetchCertificate } from "./certificateApi";
import { REFERENCE_PROBLEMS, looksLikeReference, parseReference } from "./reference";
import VerifyCertificateForm from "./VerifyCertificateForm";

const ISSUER = "Al Syed Initiative";

// Short names for the minimal card ("Verified: valid OSINT certificate issued ...").
const TYPE_NAMES = {
  OSINT: "OSINT",
  PEN: "penetration testing",
  CTF: "CTF",
  COURSE: "course",
  EXAM: "exam",
  BADGE: "badge",
  LEVEL: "learner progression",
};

/** True when the payload is the full certificate (older APIs sent no `full` flag: always full). */
function isFullCertificate(data) {
  return Boolean(data) && data.full !== false;
}

function formatIssued(isoDate) {
  if (!isoDate) return "";
  const parsed = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

const PROBLEMS = {
  missing: {
    title: "No certificate has this reference number",
    body: "Check the number against the certificate. If it is right, the certificate was not issued by us.",
  },
  typo: { title: "This reference number has a typo", body: REFERENCE_PROBLEMS.check },
  invalid: { title: "That is not a reference number", body: REFERENCE_PROBLEMS.format },
  busy: { title: "Too many checks from this connection", body: "Please wait a minute and try again." },
  error: { title: "This certificate cannot be checked right now", body: "Please try again in a few minutes." },
};

// The certificate just loaded under a slug, waiting for its canonical address (used once).
const seen = new Map();

/** Loads the certificate; `{ status: "loading" | "ready" | <problem kind>, data }`. */
function useCertificate(identifier) {
  const local = identifier && looksLikeReference(identifier) ? parseReference(identifier) : null;
  const localProblem = local && !local.ok ? (local.reason === "check" ? "typo" : "invalid") : null;
  const [state, setState] = useState({ status: "loading", data: null, key: null });

  useEffect(() => {
    if (!identifier || localProblem) return undefined;
    let active = true;
    if (seen.has(identifier)) {
      const cached = seen.get(identifier);
      seen.delete(identifier); // one use: a later visit always asks the server (revocation is never stale)
      setState({ status: "ready", data: cached, key: identifier });
      return undefined;
    }
    setState({ status: "loading", data: null, key: identifier });
    fetchCertificate(identifier)
      .then((data) => {
        // A slug or loose spelling is replaced by the canonical address, which then opens without a second request.
        if (data?.reference && data.reference !== identifier) seen.set(data.reference, data);
        if (active) setState({ status: data ? "ready" : "error", data, key: identifier });
      })
      .catch((error) => active && setState({ status: certificateErrorKind(error), data: null, key: identifier }));
    return () => {
      active = false;
    };
  }, [identifier, localProblem]);

  if (!identifier) return { status: "form", data: null };
  if (localProblem) return { status: localProblem, data: null };
  return state.key === identifier ? state : { status: "loading", data: null };
}

/** Sets <title> and description while the page is open, then restores them.
 * Certificates are private: the head never carries the holder's name or the artwork. */
function useCertificateMeta(data) {
  useEffect(() => {
    if (typeof document === "undefined" || !data?.reference) return undefined;
    const title = data.valid ? `Verified certificate ${data.reference} | ${ISSUER}` : `Revoked certificate ${data.reference} | ${ISSUER}`;
    const description = data.valid
      ? `A genuine certificate issued by ${ISSUER}. Reference ${data.reference}.`
      : `${ISSUER} revoked this certificate. It is no longer valid.`;
    const wanted = [
      ["name", "description", description],
      ["name", "robots", "noindex, follow"],
      ["property", "og:title", title],
      ["property", "og:description", description],
      ["name", "twitter:card", "summary"],
      ["name", "twitter:title", title],
      ["name", "twitter:description", description],
    ];
    const previousTitle = document.title;
    const restore = wanted.map(([attr, key, content]) => {
      let element = document.head?.querySelector?.(`meta[${attr}="${key}"]`);
      const before = element ? element.getAttribute("content") : null;
      if (!element && document.head && document.createElement) {
        element = document.createElement("meta");
        element.setAttribute(attr, key);
        document.head.appendChild(element);
      }
      element?.setAttribute("content", content || "");
      return () => (before === null ? element?.remove?.() : element?.setAttribute("content", before));
    });
    document.title = title;
    return () => {
      restore.forEach((undo) => undo());
      document.title = previousTitle;
    };
  }, [data]);
}

function StatusBadge({ valid }) {
  return (
    <p className={`cv-status ${valid ? "cv-status--valid" : "cv-status--revoked"}`}>
      <span className="cv-status__icon" aria-hidden="true">
        {valid ? "✓" : "✕"}
      </span>
      {valid ? "Verified" : "Revoked"}
    </p>
  );
}

function CopyLink({ url }) {
  const [message, setMessage] = useState("");
  const copy = async () => {
    try {
      await globalThis.navigator?.clipboard?.writeText(url);
      setMessage("Link copied.");
    } catch {
      setMessage("Copy failed. Select the address bar to copy the link.");
    }
  };
  return (
    <>
      <button className="cv-button" type="button" onClick={copy}>
        Copy link
      </button>
      <span className="cv-sr" role="status" aria-live="polite">
        {message}
      </span>
    </>
  );
}

/** What everyone but the holder sees: genuine or not, the type, the issue date and the reference. */
function MinimalCertificateView({ data }) {
  const valid = Boolean(data.valid);
  const kind = TYPE_NAMES[data.type] || (data.type_label ? data.type_label.toLowerCase() : "");
  const issued = formatIssued(data.issued_on);
  const location = useLocation();
  const next = encodeURIComponent(`${location.pathname}${location.search || ""}`);
  return (
    <>
      <header className="cv-head">
        <StatusBadge valid={valid} />
        <h1 className="cv-head__title">{valid ? "This certificate is genuine" : "This certificate was revoked"}</h1>
        <p className="cv-head__lede" data-testid="cv-minimal">
          {valid
            ? `Verified: valid ${kind ? `${kind} ` : ""}certificate issued ${issued}.`
            : `${ISSUER} withdrew this certificate. It is no longer valid and should not be relied on.`}
        </p>
        <p className="cv-head__ref">
          Reference number <span className="cv-mono">{data.reference}</span>
        </p>
      </header>

      <dl className="cv-facts">
        <div>
          <dt>Certificate type</dt>
          <dd>{data.type_label || data.type}</dd>
        </div>
        <div>
          <dt>Date of issue</dt>
          <dd>{issued}</dd>
        </div>
        <div>
          <dt>Issued by</dt>
          <dd>{data.issuer?.name || ISSUER}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{valid ? "Verified" : "Revoked"}</dd>
        </div>
      </dl>

      <p className="cv-head__lede cv-private-note">
        The certificate itself is private to its holder. If it is yours,{" "}
        <Link to={`/login?next=${next}`}>sign in</Link> to see and download it.
      </p>
    </>
  );
}

function CertificateView({ data }) {
  const valid = Boolean(data.valid);
  const name = data.recipient_name || "Name not on record";
  const issued = data.print?.texts?.dateValue || data.issued_on;
  const download = (url) => `${url}${url.includes("?") ? "&" : "?"}download=1`;
  return (
    <>
      <header className="cv-head">
        <StatusBadge valid={valid} />
        <h1 className="cv-head__title">{valid ? "This certificate is genuine" : "This certificate was revoked"}</h1>
        <p className="cv-head__lede">
          {valid
            ? `${ISSUER} issued this certificate to ${name} on ${issued}.`
            : `${ISSUER} withdrew this certificate. It is no longer valid and should not be relied on.`}
        </p>
        <p className="cv-head__ref">
          Reference number <span className="cv-mono">{data.reference}</span>
        </p>
      </header>

      <div className="cv-stage">
        <CertificateArtwork print={data.print} qr={data.qr} label={`${data.heading} for ${name}: ${data.title}. Reference ${data.reference}.`} />
      </div>

      <div className="cv-actions" aria-label="Certificate actions" role="group">
        <a className="cv-button cv-button--primary" href={data.pdf_url} download={`${data.reference}.pdf`}>
          Download PDF
        </a>
        <a className="cv-button" href={download(data.image_url)} download={`${data.reference}.png`}>
          Download image
        </a>
        {valid ? (
          <a className="cv-button" href={data.linkedin_add_url} target="_blank" rel="noopener noreferrer">
            Add to LinkedIn profile<span className="cv-sr"> (opens in a new tab)</span>
          </a>
        ) : null}
        <CopyLink url={data.verify_url} />
      </div>

      <dl className="cv-facts">
        <div>
          <dt>Awarded to</dt>
          <dd>{name}</dd>
        </div>
        <div>
          <dt>{data.heading}</dt>
          <dd>{data.title}</dd>
        </div>
        {data.programme ? (
          <div>
            <dt>Programme</dt>
            <dd>{data.programme}</dd>
          </div>
        ) : null}
        <div>
          <dt>Date of issue</dt>
          <dd>{issued}</dd>
        </div>
        <div>
          <dt>Issued by</dt>
          <dd>{data.issuer?.name || ISSUER}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{valid ? "Verified" : "Revoked"}</dd>
        </div>
        {data.revision > 1 ? (
          <div>
            <dt>Revision</dt>
            <dd>{data.revision} (re-issued with a correction; same reference number)</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

export default function CertificatePage() {
  const { reference = "" } = useParams();
  const navigate = useNavigate();
  const { status, data } = useCertificate(reference);
  useCertificateMeta(status === "ready" ? data : null);

  // A slug or a loosely typed reference: show the canonical address.
  useEffect(() => {
    if (status === "ready" && data?.reference && data.reference !== reference) {
      navigate(`/certificates/${data.reference}`, { replace: true });
    }
  }, [status, data, reference, navigate]);

  const problem = PROBLEMS[status];
  return (
    <main className="cv-page">
      <div className="cv-wrap">
        <p className="cv-kicker">
          <span>Certificate verification</span>
          <span className="cv-kicker__rule" aria-hidden="true" />
          <span>{ISSUER}</span>
        </p>

        {status === "form" ? (
          <header className="cv-head">
            <h1 className="cv-head__title">Verify a certificate</h1>
            <p className="cv-head__lede">
              Every certificate from {ISSUER} has a reference number. Enter it to see the certificate and whether it is still valid.
            </p>
          </header>
        ) : null}

        {status === "loading" ? (
          <p className="cv-loading" role="status">
            Checking this certificate…
          </p>
        ) : null}

        {problem ? (
          <section className="cv-problem" aria-labelledby="cv-problem-title">
            <p className="cv-status cv-status--revoked">
              <span className="cv-status__icon" aria-hidden="true">
                ✕
              </span>
              Not verified
            </p>
            <h1 id="cv-problem-title" className="cv-head__title">
              {problem.title}
            </h1>
            <p className="cv-head__lede">{problem.body}</p>
          </section>
        ) : null}

        {status === "ready" && data ? (
          isFullCertificate(data) ? <CertificateView data={data} /> : <MinimalCertificateView data={data} />
        ) : null}

        {status !== "loading" ? (
          <section className="cv-verify-band">
            <VerifyCertificateForm
              key={reference}
              heading={status === "form" ? "Reference number" : "Verify another certificate"}
              headingLevel={2}
              initialValue={problem ? reference : ""}
            />
          </section>
        ) : null}

        <p className="cv-foot">
          <Link to="/courses">Explore our courses</Link>
        </p>
      </div>
    </main>
  );
}

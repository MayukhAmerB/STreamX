import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { getJoinSettings, listJoinLocations, submitJoinApplication } from "../api/join";
import joinSideImage from "../assets/join-side.jpg";
import TurnstileWidget from "../components/TurnstileWidget";
import { useAuth } from "../hooks/useAuth";
import { useTurnstileChallenge } from "../hooks/useTurnstileChallenge";
import { apiData, apiMessage } from "../utils/api";
import "./JoinAlSyedPage.css";

const DEFAULT_INSTAGRAM_URL = "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg==";
const INDIA_MOBILE_RE = /^[6-9]\d{9}$/;

const ROLES = [
  {
    value: "citizen",
    title: "Citizen / Volunteer",
    description: "For individuals who want to support through legal complaints, coordination, and on-ground action.",
    icon: "people",
  },
  {
    value: "lawyer",
    title: "Lawyer",
    description: "For practicing or law-eligible advocates who can assist with legal drafting, FIRs, and broader prosecution support.",
    icon: "scales",
  },
];

const STEPS = [
  { key: "name", label: "Name" },
  { key: "details", label: "Details" },
  { key: "review", label: "Review" },
];

const TERMS_SECTIONS = [
  {
    title: "Eligibility",
    body: "You confirm that you are at least 18 years old, reside in India, and that the information you submit is true and belongs to you.",
  },
  {
    title: "Purpose of your information",
    body: "Your name, age, contact number and location are collected only to verify your identity, assess your role, and coordinate legal and civic response activities of the Al Syed Initiative.",
  },
  {
    title: "Consent to be contacted",
    body: "You agree that Team Al Syed may contact you by phone call, SMS or WhatsApp on the number you provide for verification and coordination.",
  },
  {
    title: "Verification and acceptance",
    body: "Submitting this form does not guarantee membership. The team may verify your details, ask for additional documents, or decline any application at its discretion.",
  },
  {
    title: "Lawful and peaceful conduct",
    body: "Members must act within the law at all times, follow official instructions, and must not misuse the Al Syed name for personal, political or unlawful purposes.",
  },
  {
    title: "Confidentiality",
    body: "Case details, complaints and internal communications shared with you are confidential and must not be disclosed publicly without written approval from the team.",
  },
  {
    title: "Lawyers",
    body: "Advocates confirm they are enrolled with a State Bar Council or are law-eligible, and that any assistance is provided in accordance with professional ethics.",
  },
  {
    title: "Data protection",
    body: "Your information is stored securely, is never sold, and is shared only with authorised coordinators. You may request correction or deletion of your data by contacting the team.",
  },
];

const EMPTY_FORM = {
  role: "",
  full_name: "",
  age: "",
  phone_number: "",
  address: "",
  state: "",
  district: "",
  terms_accepted: false,
};

export function normalizeLocations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item.state === "string" && Array.isArray(item.districts))
    .map((item) => ({ state: item.state, districts: item.districts.filter((district) => typeof district === "string") }));
}

export function isValidIndianMobile(value) {
  return INDIA_MOBILE_RE.test(String(value || ""));
}

export function isValidAge(value) {
  if (value === "" || value === null || value === undefined) return true;
  const age = Number(value);
  return Number.isInteger(age) && age >= 18 && age <= 100;
}

export function isDetailsComplete(form) {
  return Boolean(
    isValidAge(form.age) &&
      isValidIndianMobile(form.phone_number) &&
      form.state &&
      form.district &&
      form.terms_accepted,
  );
}

export function buildJoinPayload(form) {
  return {
    role: form.role,
    full_name: form.full_name.trim(),
    age: form.age === "" ? null : Number(form.age),
    phone_number: `+91${form.phone_number}`,
    address: form.address.trim(),
    state: form.state,
    district: form.district,
    terms_accepted: form.terms_accepted,
  };
}

export function pickInstagramUrl(settings) {
  const url = typeof settings?.instagram_url === "string" ? settings.instagram_url.trim() : "";
  return /^https?:\/\//i.test(url) ? url : DEFAULT_INSTAGRAM_URL;
}

/* ---------- icons ---------- */

function Icon({ name }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  switch (name) {
    case "arrow-left":
      return (
        <svg {...common}>
          <path d="M20 12H4M10 6l-6 6 6 6" />
        </svg>
      );
    case "arrow-right":
      return (
        <svg {...common}>
          <path d="M4 12h16M14 6l6 6-6 6" />
        </svg>
      );
    case "people":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.4" />
          <path d="M3 19.5c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6Z" />
          <path d="M15.2 4.9a3.2 3.2 0 1 1 1.4 6" />
          <path d="M17.6 13.9c2 .6 3.4 2.4 3.4 4.8h-3.2" />
        </svg>
      );
    case "scales":
      return (
        <svg {...common}>
          <circle cx="12" cy="4.3" r="1.3" />
          <path d="M12 5.6V20M7.5 20h9M5 7.5h14" />
          <path d="M6.5 7.5 3.5 13.5a3 3 0 0 0 6 0Z" />
          <path d="m17.5 7.5-3 6a3 3 0 0 0 6 0Z" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </svg>
      );
    case "phone":
      return (
        <svg {...common}>
          <path d="M6.6 3.5h2.6l1.6 4.2-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4.2 1.6v2.6a2 2 0 0 1-2.2 2A16.6 16.6 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
          <circle cx="12" cy="10" r="2.4" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "check":
      return (
        <svg {...common} strokeWidth={2.6}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      );
    case "instagram":
      return (
        <svg {...common} strokeWidth={1.9}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" />
        </svg>
      );
    case "external":
      return (
        <svg {...common} strokeWidth={1.9}>
          <path d="M13.5 4.5h6v6M19.5 4.5l-8.5 8.5" />
          <path d="M17.5 13.5v4.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h4.5" />
        </svg>
      );
    default:
      return null;
  }
}

/* ---------- decorative arch ---------- */

const ARCH_PATH =
  "M40 330 V188 C40 150 78 128 118 112 C150 99 172 82 184 60 C190 48 194 36 200 22 C206 36 210 48 216 60 C228 82 250 99 282 112 C322 128 360 150 360 188 V330";

export function JoinArchOrnament() {
  const patternId = useId().replace(/:/g, "");
  return (
    <div className="join-arch" aria-hidden="true">
      <svg viewBox="0 0 400 330" preserveAspectRatio="xMidYMax meet">
        <defs>
          <pattern id={`${patternId}-damask`} width="44" height="44" patternUnits="userSpaceOnUse">
            <g fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round">
              <path d="M22 4c6 5 6 11 0 15-6-4-6-10 0-15Z" />
              <path d="M22 19v6M22 25c-5 0-9 3-10 8M22 25c5 0 9 3 10 8" />
              <path d="M12 33c-3-1-5-4-4-7 3 0 5 3 4 7ZM32 33c3-1 5-4 4-7-3 0-5 3-4 7Z" />
              <path d="M0 22c4-3 8-3 10 0-2 3-6 3-10 0ZM44 22c-4-3-8-3-10 0 2 3 6 3 10 0Z" />
              <path d="M4 4c3 1 4 4 3 6M40 4c-3 1-4 4-3 6M4 40c3-1 4-4 3-6M40 40c-3-1-4-4-3-6" />
              <circle cx="22" cy="38" r="1.6" />
            </g>
          </pattern>
          <linearGradient id={`${patternId}-fade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.45" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fff" stopOpacity="1" />
          </linearGradient>
          <mask id={`${patternId}-mask`}>
            <rect width="400" height="330" fill={`url(#${patternId}-fade)`} />
          </mask>
        </defs>
        <g mask={`url(#${patternId}-mask)`}>
          <rect width="400" height="330" fill={`url(#${patternId}-damask)`} className="join-arch-field" />
          <path d={ARCH_PATH} fill="#050505" className="join-arch-inner-bg" />
          <path d={ARCH_PATH} fill={`url(#${patternId}-damask)`} className="join-arch-inner" />
          <path d={ARCH_PATH} fill="none" className="join-arch-line join-arch-line--outer" />
          <path
            d={ARCH_PATH}
            fill="none"
            className="join-arch-line join-arch-line--inner"
            transform="translate(200 330) scale(0.9) translate(-200 -330)"
          />
        </g>
      </svg>
    </div>
  );
}

/* ---------- shared pieces ---------- */

function FormHeader({ onBack, divided = false }) {
  return (
    <div className="join-topbar">
      <button type="button" className="join-back" onClick={onBack} aria-label="Go back">
        <Icon name="arrow-left" />
      </button>
      {divided ? <span className="join-topbar-divider" aria-hidden="true" /> : null}
      <span className="join-topbar-label">Joining Form</span>
    </div>
  );
}

export function JoinStepper({ current }) {
  const currentIndex = STEPS.findIndex((step) => step.key === current);
  return (
    <ol className="join-stepper" aria-label="Form progress">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming";
        return (
          <li key={step.key} className={`join-step join-step--${state}`} aria-current={state === "current" ? "step" : undefined}>
            {index > 0 ? (
              <span className={`join-step-line ${index <= currentIndex ? "is-active" : ""}`} aria-hidden="true" />
            ) : null}
            <span className="join-step-node" aria-hidden="true">
              {state === "done" ? <Icon name="check" /> : null}
            </span>
            <span className="join-step-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Intro({ title, children }) {
  return (
    <>
      <span className="join-pill">Al Syed Form</span>
      <h1 className="join-title">{title}</h1>
      <p className="join-subtitle">{children}</p>
    </>
  );
}

function ContinueButton({ disabled, loading, label = "Continue", type = "submit" }) {
  return (
    <button type={type} className="join-continue" disabled={disabled || loading} aria-busy={loading || undefined}>
      <span>{loading ? "Submitting" : label}</span>
      <Icon name="arrow-right" />
    </button>
  );
}

function FieldLabel({ htmlFor, title, hint, required = false }) {
  return (
    <div className="join-field-label">
      <label htmlFor={htmlFor}>
        {title}
        {required ? <span className="join-required" aria-hidden="true"> *</span> : null}
      </label>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}

/* ---------- steps ---------- */

export function RoleStep({ role, onSelect, onContinue, onBack }) {
  return (
    <form
      className="join-step-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (role) onContinue();
      }}
    >
      <FormHeader onBack={onBack} />
      <Intro title="Join Al Syed">
        Fill out the joining form to be part of our coordinated legal and civic response network.
      </Intro>
      <hr className="join-rule" />
      <h2 className="join-section-title">Select Your Role</h2>
      <p className="join-section-hint">Choose the option that best describes you.</p>
      <div className="join-roles" role="radiogroup" aria-label="Select your role">
        {ROLES.map((item) => {
          const selected = role === item.value;
          return (
            <label key={item.value} className={`join-role ${selected ? "is-selected" : ""}`}>
              <input
                type="radio"
                name="role"
                value={item.value}
                checked={selected}
                onChange={() => onSelect(item.value)}
                className="join-visually-hidden"
              />
              <span className="join-role-icon">
                <Icon name={item.icon} />
              </span>
              <span className="join-role-copy">
                <span className="join-role-title">{item.title}</span>
                <span className="join-role-desc">{item.description}</span>
              </span>
              <span className="join-radio" aria-hidden="true" />
            </label>
          );
        })}
      </div>
      <ContinueButton disabled={!role} />
    </form>
  );
}

export function NameStep({ value, onChange, onContinue, onBack }) {
  const trimmed = value.trim();
  return (
    <form
      className="join-step-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed.length >= 2) onContinue();
      }}
    >
      <FormHeader onBack={onBack} />
      <JoinStepper current="name" />
      <Intro title="Enter Your Name">Please provide your full name as per your official documents.</Intro>
      <label htmlFor="join-full-name" className="join-caps-label">
        Full Name
      </label>
      <input
        id="join-full-name"
        className="join-input join-input--plain"
        type="text"
        autoComplete="name"
        maxLength={160}
        placeholder="Enter your full name"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
      />
      <ContinueButton disabled={trimmed.length < 2} />
    </form>
  );
}

export function DetailsStep({
  form,
  locations,
  locationsError,
  onField,
  onOpenTerms,
  onSubmit,
  onBack,
  submitting,
  error,
  turnstileSlot,
  submitBlocked = false,
}) {
  const districts = locations.find((item) => item.state === form.state)?.districts || [];
  const ageInvalid = form.age !== "" && !isValidAge(form.age);
  const phoneInvalid = form.phone_number.length === 10 && !isValidIndianMobile(form.phone_number);
  const complete = isDetailsComplete(form);

  return (
    <form
      className="join-step-panel"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !submitBlocked) onSubmit();
      }}
    >
      <FormHeader onBack={onBack} divided />
      <JoinStepper current="details" />
      <Intro title="Your Details">Provide your accurate information for verification and further coordination.</Intro>
      <div className="join-progress-rule" aria-hidden="true" />

      <div className="join-field">
        <FieldLabel htmlFor="join-age" title="Age" hint="Your current age" />
        <div className={`join-input-wrap ${ageInvalid ? "is-invalid" : ""}`}>
          <span className="join-input-icon">
            <Icon name="calendar" />
          </span>
          <input
            id="join-age"
            className="join-input"
            type="text"
            inputMode="numeric"
            maxLength={3}
            placeholder="Enter your age"
            value={form.age}
            onChange={(event) => onField("age", event.target.value.replace(/\D/g, ""))}
            aria-invalid={ageInvalid || undefined}
          />
        </div>
        {ageInvalid ? <p className="join-field-error">You must be between 18 and 100 years old.</p> : null}
      </div>

      <div className="join-field">
        <FieldLabel
          htmlFor="join-phone"
          title="Contact Number"
          hint="An active number is required for verification and communication."
          required
        />
        <div className={`join-input-wrap ${phoneInvalid ? "is-invalid" : ""}`}>
          <span className="join-input-icon">
            <Icon name="phone" />
          </span>
          <span className="join-dial-code" title="Only Indian mobile numbers are accepted" aria-label="India, +91">
            +91
            <Icon name="chevron-down" />
          </span>
          <span className="join-dial-divider" aria-hidden="true" />
          <input
            id="join-phone"
            className="join-input"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={10}
            placeholder="Enter your mobile number"
            value={form.phone_number}
            onChange={(event) => onField("phone_number", event.target.value.replace(/\D/g, "").slice(0, 10))}
            aria-invalid={phoneInvalid || undefined}
            required
          />
        </div>
        {phoneInvalid ? <p className="join-field-error">Enter a valid 10-digit Indian mobile number.</p> : null}
      </div>

      <div className="join-field">
        <FieldLabel htmlFor="join-address" title="Location / Address" hint="Enter your area, locality or complete address." />
        <div className="join-input-wrap">
          <span className="join-input-icon">
            <Icon name="pin" />
          </span>
          <input
            id="join-address"
            className="join-input"
            type="text"
            autoComplete="street-address"
            maxLength={300}
            placeholder="Enter your location or full address"
            value={form.address}
            onChange={(event) => onField("address", event.target.value)}
          />
        </div>
      </div>

      <div className="join-location-grid">
        <div className="join-field">
          <FieldLabel htmlFor="join-state" title="State" hint="Select your state" required />
          <div className="join-select-wrap">
            <select
              id="join-state"
              className="join-select"
              value={form.state}
              onChange={(event) => onField("state", event.target.value)}
              required
            >
              <option value="">Select state</option>
              {locations.map((item) => (
                <option key={item.state} value={item.state}>
                  {item.state}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" />
          </div>
        </div>
        <span className="join-location-divider" aria-hidden="true" />
        <div className="join-field">
          <FieldLabel htmlFor="join-district" title="District" hint="Select your district" required />
          <div className="join-select-wrap">
            <select
              id="join-district"
              className="join-select"
              value={form.district}
              onChange={(event) => onField("district", event.target.value)}
              disabled={!form.state}
              required
            >
              <option value="">Select district</option>
              {districts.map((district) => (
                <option key={district} value={district}>
                  {district}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" />
          </div>
        </div>
      </div>
      {locationsError ? <p className="join-field-error">{locationsError}</p> : null}

      <div className="join-terms">
        <input
          id="join-terms"
          type="checkbox"
          className="join-checkbox"
          checked={form.terms_accepted}
          onChange={(event) => onField("terms_accepted", event.target.checked)}
          required
        />
        <label htmlFor="join-terms">
          I have read and agree to the{" "}
          <button type="button" className="join-terms-link" onClick={onOpenTerms}>
            Terms and Conditions.
          </button>
          <span className="join-required" aria-hidden="true"> *</span>
        </label>
      </div>

      {turnstileSlot}
      {error ? (
        <p className="join-form-error" role="alert">
          {error}
        </p>
      ) : null}
      <ContinueButton disabled={!complete || submitBlocked} loading={submitting} />
    </form>
  );
}

export function SubmittedStep({ instagramUrl }) {
  return (
    <div className="join-step-panel join-submitted">
      <div className="join-success-mark" aria-hidden="true">
        <Icon name="check" />
      </div>
      <h1 className="join-title join-title--center">Form Submitted</h1>
      <p className="join-submitted-copy">
        Your joining form has been successfully received. The <strong>Team Al Syed</strong> will review your details and
        contact you soon on your provided number.
      </p>
      <div className="join-next-card">
        <span className="join-next-icon">
          <Icon name="calendar" />
        </span>
        <span className="join-next-divider" aria-hidden="true" />
        <div>
          <h2>Next Step</h2>
          <p>Our team will verify your information and reach out to you for further coordination.</p>
        </div>
      </div>
      <a className="join-updates" href={instagramUrl} target="_blank" rel="noopener noreferrer">
        <span className="join-updates-icon">
          <Icon name="instagram" />
        </span>
        <span className="join-updates-divider" aria-hidden="true" />
        <span className="join-updates-label">Get the Updates</span>
        <span className="join-updates-external">
          <Icon name="external" />
        </span>
      </a>
      <p className="join-updates-caption">
        Join our Instagram Broadcast Channel for all official updates, announcements and further instructions.
      </p>
    </div>
  );
}

function TermsDialog({ open, onClose, onAgree }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  // Portalled so the dialog stacks above the sticky site navbar.
  return createPortal(
    <div className="join-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="join-modal" role="dialog" aria-modal="true" aria-labelledby="join-terms-title">
        <div className="join-modal-head">
          <span className="join-pill">Al Syed Form</span>
          <h2 id="join-terms-title">Terms and Conditions</h2>
          <p>Please read these terms carefully before submitting your joining form.</p>
        </div>
        <ol className="join-modal-body">
          {TERMS_SECTIONS.map((section) => (
            <li key={section.title}>
              <h3>{section.title}</h3>
              <p>{section.body}</p>
            </li>
          ))}
        </ol>
        <div className="join-modal-actions">
          <button type="button" className="join-modal-secondary" onClick={onClose} ref={closeRef}>
            Close
          </button>
          <button type="button" className="join-continue join-modal-agree" onClick={onAgree}>
            <span>I Agree</span>
            <Icon name="arrow-right" />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- page ---------- */

export default function JoinAlSyedPage() {
  const navigate = useNavigate();
  const { turnstileEnabled, turnstileSiteKey } = useAuth();
  const turnstile = useTurnstileChallenge(turnstileEnabled);
  const [step, setStep] = useState("role");
  const [form, setForm] = useState(EMPTY_FORM);
  const [locations, setLocations] = useState([]);
  const [locationsError, setLocationsError] = useState("");
  const [instagramUrl, setInstagramUrl] = useState(DEFAULT_INSTAGRAM_URL);
  const [termsOpen, setTermsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const closeTerms = useCallback(() => setTermsOpen(false), []);

  useEffect(() => {
    let active = true;
    listJoinLocations()
      .then((response) => {
        if (active) setLocations(normalizeLocations(apiData(response, [])));
      })
      .catch((err) => {
        if (active) setLocationsError(apiMessage(err, "Could not load states and districts. Refresh and try again."));
      });
    getJoinSettings()
      .then((response) => {
        if (active) setInstagramUrl(pickInstagramUrl(apiData(response, null)));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  const setField = (field, value) => {
    setError("");
    setForm((prev) => ({
      ...prev,
      [field]: value,
      ...(field === "state" ? { district: "" } : {}),
    }));
  };

  const handleSubmit = async () => {
    const securityError = turnstile.requireToken();
    if (securityError) {
      setError(securityError);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await submitJoinApplication({ ...buildJoinPayload(form), ...turnstile.payload });
      setStep("submitted");
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(apiMessage(err, "We could not submit your form. Please try again."));
      turnstile.reset();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="join-page">
      <div className="join-side" aria-hidden="true">
        <img src={joinSideImage} alt="" decoding="async" />
      </div>
      <div className="join-container">
        {step === "role" ? (
          <RoleStep
            role={form.role}
            onSelect={(value) => setField("role", value)}
            onContinue={() => setStep("name")}
            onBack={() => navigate(-1)}
          />
        ) : null}
        {step === "name" ? (
          <NameStep
            value={form.full_name}
            onChange={(value) => setField("full_name", value)}
            onContinue={() => setStep("details")}
            onBack={() => setStep("role")}
          />
        ) : null}
        {step === "details" ? (
          <DetailsStep
            form={form}
            locations={locations}
            locationsError={locationsError}
            onField={setField}
            onOpenTerms={() => setTermsOpen(true)}
            onSubmit={handleSubmit}
            onBack={() => setStep("name")}
            submitting={submitting}
            error={error}
            submitBlocked={Boolean(turnstileEnabled && !turnstile.token)}
            turnstileSlot={
              turnstileEnabled ? (
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  action="join_alsyed"
                  onToken={turnstile.setToken}
                  onExpire={turnstile.expire}
                  onError={() => {
                    turnstile.expire();
                    setError("Security check failed to load. Refresh the page and try again.");
                  }}
                  resetSignal={turnstile.resetSignal}
                  className="join-turnstile"
                />
              ) : null
            }
          />
        ) : null}
        {step === "submitted" ? <SubmittedStep instagramUrl={instagramUrl} /> : null}
      </div>
      <JoinArchOrnament />
      <TermsDialog
        open={termsOpen}
        onClose={closeTerms}
        onAgree={() => {
          setField("terms_accepted", true);
          setTermsOpen(false);
        }}
      />
    </section>
  );
}

import { useState } from "react";
import { sendContactMessage } from "../api/auth";
import TurnstileWidget from "../components/TurnstileWidget";
import { useTurnstileChallenge } from "../hooks/useTurnstileChallenge";
import { useAuth } from "../hooks/useAuth";
import { Band, Button, Column } from "../site-kit";
import { apiMessage } from "../utils/api";
import { ArrowRight } from "./landing/LandingParts";
import SiteField from "./landing/SiteField";
import "./landing/sitePages.css";

const contactLinks = [
  {
    name: "Instagram",
    href: "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg==",
    handle: "@adlfrontofficial",
  },
  {
    name: "X",
    href: "https://x.com/AdlFront",
    handle: "@AdlFront",
  },
  {
    name: "WhatsApp (Primary)",
    href: "https://wa.me/919970875040",
    handle: "+91 99708 75040",
  },
  {
    name: "WhatsApp (Alternate)",
    href: "https://wa.me/919800415583",
    handle: "+91 9800415583",
  },
  {
    name: "Email",
    href: "mailto:contact@adlfront.com",
    handle: "contact@adlfront.com",
  },
];

function ContactChannelIcon({ name }) {
  if (name === "Instagram") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" focusable="false">
        <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="17" cy="7" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  if (name === "X") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" focusable="false">
        <path d="M6 5l12 14M17.6 5L6.4 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name.startsWith("WhatsApp")) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" focusable="false">
        <path d="M12 4.5a7.5 7.5 0 0 0-6.6 11.1L4.7 19l3.5-.6A7.5 7.5 0 1 0 12 4.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9.7 9.2c-.2-.5-.5-.4-.7-.4h-.3c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2s.8 2.4.9 2.6c.1.2 1.5 2.4 3.7 3.2 1.8.7 2.2.6 2.5.5.4-.1 1.1-.5 1.2-1 .1-.4.1-.8.1-.9-.1-.1-.3-.2-.7-.4s-1.1-.5-1.3-.6c-.2-.1-.4-.1-.5.1-.2.2-.6.6-.7.8-.1.2-.3.2-.5.1-.2-.1-.9-.3-1.6-1-.6-.6-1-1.3-1.2-1.6-.1-.2 0-.3.1-.4l.3-.4.2-.3c.1-.1.1-.3 0-.4l-.7-1.7Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="20" height="20" focusable="false">
      <path d="M4 7h16v10H4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.8 7.8l7.2 5.6 7.2-5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ContactPage() {
  const { turnstileEnabled, turnstileSiteKey } = useAuth();
  const turnstile = useTurnstileChallenge(turnstileEnabled);
  const [form, setForm] = useState({
    name: "",
    email: "",
    subject: "",
    message: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const onChange = (key) => (e) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    const securityError = turnstile.requireToken();
    if (securityError) {
      setError(securityError);
      setSuccess("");
      return;
    }
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      await sendContactMessage({ ...form, ...turnstile.payload });
      setSuccess("Message sent. We will get back to you soon.");
      setForm({ name: "", email: "", subject: "", message: "" });
      turnstile.reset();
    } catch (err) {
      setError(apiMessage(err, "Unable to send your message right now."));
      turnstile.reset();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sp sp-contact">
      <Band theme="g100" labelledBy="sp-contact-title">
        <Column sm={4} md={8} lg={7}>
          <p className="sp-eyebrow sp-eyebrow--draw">Contact</p>
          <h1 id="sp-contact-title" className="sp-title">
            Talk to the team
          </h1>
          <p className="sp-lead">
            Message us on WhatsApp, Instagram or X, e-mail the team, or use the form. We usually reply within one working
            day.
          </p>

          <h2 className="sp-label sp-contact__channels-title">Channels</h2>
          <ul className="sp-channels">
            {contactLinks.map((item) => {
              const isMail = item.href.startsWith("mailto:");
              return (
                <li key={`${item.name}-${item.href}`}>
                  <a
                    href={item.href}
                    target={isMail ? undefined : "_blank"}
                    rel={isMail ? undefined : "noopener noreferrer"}
                    className="sp-channel"
                  >
                    <span className="sp-channel__icon">
                      <ContactChannelIcon name={item.name} />
                    </span>
                    <span className="sp-channel__text">
                      <span className="sp-channel__name">{item.name}</span>
                      <span className="sp-channel__handle">{item.handle}</span>
                    </span>
                    <ArrowRight className="sp-link-tile__arrow sp-channel__arrow" />
                    {isMail ? null : <span className="sk-visually-hidden"> (opens in a new tab)</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </Column>

        <Column sm={4} md={8} lg={7} start={10}>
          <section className="sp-panel" aria-labelledby="sp-contact-form-title">
            <div className="sp-panel__head">
              <h2 id="sp-contact-form-title" className="sp-h2">
                Send a message
              </h2>
              <p className="sp-lead">Tell us what you need and how to reach you. It goes straight to the team.</p>
            </div>

            <form onSubmit={onSubmit} className="sp-form">
              <div className="sp-form__pair">
                <SiteField label="Name" name="name" autoComplete="name" value={form.name} onChange={onChange("name")} required />
                <SiteField
                  label="Email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={onChange("email")}
                  required
                />
              </div>
              <SiteField label="Subject" name="subject" value={form.subject} onChange={onChange("subject")} required />
              <SiteField
                label="Message"
                as="textarea"
                name="message"
                rows={6}
                value={form.message}
                onChange={onChange("message")}
                minLength={10}
                hint="At least 10 characters."
                required
              />

              {error ? (
                <p className="sp-message sp-message--error" role="alert">
                  {error}
                </p>
              ) : null}
              {success ? (
                <p className="sp-message sp-message--success" role="status">
                  {success}
                </p>
              ) : null}

              {turnstileEnabled ? (
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  action="contact"
                  onToken={turnstile.setToken}
                  onExpire={turnstile.expire}
                  onError={() => {
                    turnstile.expire();
                    setError("Security check failed to load. Refresh the page and try again.");
                  }}
                  resetSignal={turnstile.resetSignal}
                />
              ) : null}

              <Button
                type="submit"
                fullWidth
                loading={loading}
                disabled={turnstileEnabled && !turnstile.token}
                disabledReason={turnstileEnabled && !turnstile.token ? "Complete the security check first." : ""}
                icon={<ArrowRight />}
              >
                Send message
              </Button>
            </form>
          </section>
        </Column>
      </Band>
    </div>
  );
}


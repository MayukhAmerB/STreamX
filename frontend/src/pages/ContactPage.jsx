import { useState } from "react";
import { sendContactMessage } from "../api/auth";
import Button from "../components/Button";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { apiMessage } from "../utils/api";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const contactLinks = [
  {
    name: "Instagram",
    href: "https://www.instagram.com/adl.response",
    handle: "@adl.response",
    accent: "from-[#DBDBDB] to-[#A9A9A9]",
  },
  {
    name: "X",
    href: "https://x.com/AdlFront",
    handle: "@AdlFront",
    accent: "from-[#E0E0E0] to-[#A8A8A8]",
  },
  {
    name: "WhatsApp (Primary)",
    href: "https://wa.me/919970875040",
    handle: "+91 99708 75040",
    accent: "from-[#DADADA] to-[#919191]",
  },
  {
    name: "WhatsApp (Alternate)",
    href: "https://wa.me/919800415583",
    handle: "+91 9800415583",
    accent: "from-[#E1E1E1] to-[#ABABAB]",
  },
  {
    name: "Email",
    href: "mailto:alsyedinitiative@gmail.com",
    handle: "alsyedinitiative@gmail.com",
    accent: "from-[#EAEAEA] to-[#CFCFCF]",
  },
];

function ContactChannelIcon({ name }) {
  if (name === "Instagram") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
        <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="17" cy="7" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  if (name === "X") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
        <path d="M6 5l12 14M17.6 5L6.4 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (name.startsWith("WhatsApp")) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
        <path d="M12 4.5a7.5 7.5 0 0 0-6.6 11.1L4.7 19l3.5-.6A7.5 7.5 0 1 0 12 4.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9.7 9.2c-.2-.5-.5-.4-.7-.4h-.3c-.2 0-.5.1-.7.4-.2.3-.8.8-.8 2s.8 2.4.9 2.6c.1.2 1.5 2.4 3.7 3.2 1.8.7 2.2.6 2.5.5.4-.1 1.1-.5 1.2-1 .1-.4.1-.8.1-.9-.1-.1-.3-.2-.7-.4s-1.1-.5-1.3-.6c-.2-.1-.4-.1-.5.1-.2.2-.6.6-.7.8-.1.2-.3.2-.5.1-.2-.1-.9-.3-1.6-1-.6-.6-1-1.3-1.2-1.6-.1-.2 0-.3.1-.4l.3-.4.2-.3c.1-.1.1-.3 0-.4l-.7-1.7Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4.5 w-4.5">
      <path d="M4 7h16v10H4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.8 7.8l7.2 5.6 7.2-5.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function ContactPage() {
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
    setLoading(true);
    setError("");
    setSuccess("");
    try {
      await sendContactMessage(form);
      setSuccess("Message sent. We will get back to you soon.");
      setForm({ name: "", email: "", subject: "", message: "" });
    } catch (err) {
      setError(apiMessage(err, "Unable to send your message right now."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageShell
      title="Contact"
      subtitle="Reach us on social platforms or send a message directly from the form below."
      decryptTitle
    >
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[28px] border border-black bg-[#080808] shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.16]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/86 via-black/80 to-[#111111]/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_83%_12%,rgba(192,192,192,0.12),transparent_36%)]" />
        </div>

        <div className="relative p-5 sm:p-7">
          <div className="mb-6 rounded-2xl border border-black panel-gradient p-5 backdrop-blur-sm">
            <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-wide text-[#DBDBDB]">
              CONTACT AL SYED INITIATIVE
            </div>
            <h2 className="mt-4 font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
              Reach us directly or send a message from the contact form
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[#BBBBBB]">
              Connect through Instagram, X, both WhatsApp numbers, or primary email. The form below
              is wired to the Django backend contact email endpoint.
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
            <section className="rounded-2xl border border-black panel-gradient p-6 backdrop-blur-sm">
              <h2 className="font-reference text-2xl font-semibold text-white">Connect With Us</h2>
              <p className="mt-3 text-sm leading-6 text-[#BBBBBB]">
                Choose your preferred channel and reach us instantly.
              </p>

              <div className="mt-5 space-y-3">
                {contactLinks.map((item) => (
                  <a
                    key={`${item.name}-${item.href}`}
                    href={item.href}
                    target={item.href.startsWith("mailto:") ? undefined : "_blank"}
                    rel={item.href.startsWith("mailto:") ? undefined : "noreferrer"}
                    className="group flex items-center justify-between rounded-xl border border-black panel-gradient p-4 transition hover:border-[#3C3C3C] hover:bg-[#181818]"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${item.accent} text-[#141414] shadow-[0_4px_12px_rgba(0,0,0,0.22)]`}>
                        <ContactChannelIcon name={item.name} />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">{item.name}</div>
                        <div className="mt-1 text-sm text-[#BBBBBB]">{item.handle}</div>
                      </div>
                    </div>
                    <div className="text-xs font-semibold tracking-wide text-[#AAAAAA] transition group-hover:text-[#DBDBDB]">
                      OPEN
                    </div>
                  </a>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-black panel-gradient p-6 backdrop-blur-sm">
              <h2 className="font-reference text-2xl font-semibold text-white">Send a Message</h2>
              <p className="mt-3 text-sm leading-6 text-[#BBBBBB]">
                This form sends email through the backend contact endpoint and SMTP configuration.
              </p>

              <form onSubmit={onSubmit} className="mt-5 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormInput label="Name" value={form.name} onChange={onChange("name")} required />
                  <FormInput
                    label="Email"
                    type="email"
                    value={form.email}
                    onChange={onChange("email")}
                    required
                  />
                </div>
                <FormInput
                  label="Subject"
                  value={form.subject}
                  onChange={onChange("subject")}
                  required
                />
                <FormInput
                  label="Message"
                  as="textarea"
                  rows={6}
                  value={form.message}
                  onChange={onChange("message")}
                  minLength={10}
                  hint="Minimum 10 characters."
                  className="[&_textarea]:resize-y"
                  required
                />

                {error ? (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    {error}
                  </div>
                ) : null}
                {success ? (
                  <div className="rounded-xl border border-zinc-500/20 bg-zinc-500/10 px-4 py-3 text-sm text-zinc-300">
                    {success}
                  </div>
                ) : null}

                <Button type="submit" loading={loading} className="w-full">
                  Send Message
                </Button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </PageShell>
  );
}


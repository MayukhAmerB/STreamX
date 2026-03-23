import { useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const faqItems = [
  {
    question: "What is this course about?",
    paragraphs: [
      "This course focuses on OSINT (Open Source Intelligence), Ethical Hacking, and Cybersecurity fundamentals.",
      "You'll learn how to gather publicly available information, understand security concepts, and apply ethical hacking techniques in a legal and responsible manner.",
    ],
  },
  {
    question: "Who is this course for?",
    beforeBullets: "This course is ideal for:",
    bullets: [
      "Beginners interested in cybersecurity and ethical hacking",
      "Students who want to build skills in OSINT and digital investigation",
      "Anyone looking to start a career in cybersecurity",
    ],
    afterBullets: "No prior experience is required.",
  },
  {
    question: "What will I learn in this course?",
    beforeBullets: "You will learn:",
    bullets: [
      "OSINT techniques for information gathering",
      "Basics of ethical hacking and cybersecurity",
      "Tools and methods used in real-world scenarios",
      "How to analyze and use publicly available data effectively",
    ],
  },
  {
    question: "Is this course legal and safe to learn?",
    paragraphs: [
      "Yes. This course is designed strictly for educational and ethical purposes only.",
      "We do not promote or support illegal activities. All knowledge must be used responsibly and within legal boundaries.",
    ],
  },
  {
    question: "How will I get access after payment?",
    beforeBullets: "Once your payment is confirmed:",
    bullets: [
      "You will receive a unique roll number on your provided contact number",
      "Along with your username and password",
      "You can log in to our website and start learning",
    ],
  },
  {
    question: "How does the login system work?",
    beforeBullets: "Each student is assigned:",
    bullets: [
      "A unique roll number",
      "A secure login ID (username & password)",
    ],
    afterBullets:
      "This ensures personalized access and helps track your course progress.",
  },
  {
    question: "Do you provide support during the course?",
    beforeBullets: "Yes, we provide support to help you:",
    bullets: [
      "Resolve doubts",
      "Understand concepts better",
      "Stay consistent with your learning",
    ],
    afterBullets: "You can contact us via WhatsApp, Telegram, or Email.",
  },
  {
    question: "Do you offer refunds?",
    paragraphs: [
      "No, we have a strict no-refund policy.",
      "Since this is a digital course and access credentials (roll number, username, and password) are issued after enrollment, all purchases are final and non-reversible.",
      "We strongly recommend reviewing all course details before making a payment.",
    ],
  },
  {
    question: "Can I share my login details with others?",
    paragraphs: ["No. Your login credentials are strictly personal."],
    beforeBullets: "Sharing access may result in:",
    bullets: [
      "Suspension or termination of your account",
      "Loss of access without any refund",
    ],
  },
  {
    question: "Will I get a certificate after completing the course?",
    paragraphs: [
      "Yes, a certificate of completion will be provided after successfully finishing the course.",
    ],
  },
];

function FaqAnswer({ item }) {
  return (
    <div className="space-y-4 text-sm leading-7 text-[#C6C6C6]">
      {item.paragraphs?.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {item.beforeBullets ? <p>{item.beforeBullets}</p> : null}
      {item.bullets?.length ? (
        <ul className="space-y-2">
          {item.bullets.map((bullet) => (
            <li
              key={bullet}
              className="flex items-start gap-3 rounded-xl border border-black bg-white/[0.03] px-4 py-3"
            >
              <span className="mt-2 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-[#D4D4D4]" />
              <span>{bullet}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {item.afterBullets ? <p>{item.afterBullets}</p> : null}
    </div>
  );
}

export default function FaqPage() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <PageShell
      title="FAQs"
      subtitle="Everything students usually ask before enrolling, paying, and getting access."
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
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_14%_14%,rgba(192,192,192,0.13),transparent_34%)]" />
        </div>

        <div className="relative p-5 sm:p-7">
          <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
            <section className="rounded-2xl border border-black panel-gradient p-6 backdrop-blur-sm">
              <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-wide text-[#DBDBDB]">
                COURSE FAQS
              </div>
              <h2 className="mt-4 font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
                Clear answers before you enroll
              </h2>
              <p className="mt-4 text-sm leading-7 text-[#BBBBBB]">
                This page covers the most common questions about the course, legal use, payment
                access, support, login rules, refunds, and certificates.
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                <div className="rounded-xl border border-black panel-gradient p-4">
                  <div className="font-reference text-lg font-semibold text-[#E0E0E0]">OSINT</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#969696]">
                    Research focused
                  </div>
                </div>
                <div className="rounded-xl border border-black panel-gradient p-4">
                  <div className="font-reference text-lg font-semibold text-[#E0E0E0]">
                    Ethical
                  </div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#969696]">
                    Legal boundaries
                  </div>
                </div>
                <div className="rounded-xl border border-black panel-gradient p-4">
                  <div className="font-reference text-lg font-semibold text-[#E0E0E0]">
                    Guided
                  </div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#969696]">
                    Support included
                  </div>
                </div>
              </div>

              <div className="mt-6 rounded-2xl border border-black bg-gradient-to-r from-[#161616] to-[#121212] p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#D5D5D5]">
                  Need More Help?
                </div>
                <p className="mt-3 text-sm leading-7 text-[#B8B8B8]">
                  If your question is not covered here, use the contact page and we will guide you
                  before enrollment.
                </p>
                <Link to="/contact" className="mt-4 inline-flex">
                  <Button
                    variant="indigoSoft"
                    className="border-white/20 bg-white/10 text-white hover:bg-white/15"
                  >
                    Go To Contact
                  </Button>
                </Link>
              </div>
            </section>

            <section className="rounded-2xl border border-black panel-gradient p-6 backdrop-blur-sm">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="font-reference text-2xl font-semibold text-white">
                    Frequently Asked Questions
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                    Open each item for the full answer.
                  </p>
                </div>
                <div className="text-xs uppercase tracking-[0.18em] text-[#8F8F8F]">
                  {faqItems.length} questions
                </div>
              </div>

              <div className="mt-5 space-y-3">
                {faqItems.map((item, index) => {
                  const isOpen = openIndex === index;
                  const itemNumber = String(index + 1).padStart(2, "0");

                  return (
                    <article
                      key={item.question}
                      className="overflow-hidden rounded-2xl border border-black bg-[#0F0F0F]/80 transition hover:border-[#3B3B3B]"
                    >
                      <button
                        type="button"
                        className="flex w-full items-start gap-4 px-5 py-4 text-left"
                        onClick={() => setOpenIndex((current) => (current === index ? -1 : index))}
                        aria-expanded={isOpen}
                      >
                        <span className="mt-1 inline-flex min-w-10 rounded-full border border-black bg-white/5 px-2.5 py-1 text-[11px] font-semibold tracking-[0.16em] text-[#D7D7D7]">
                          {itemNumber}
                        </span>
                        <span className="flex-1 font-reference text-lg font-semibold leading-7 text-white">
                          {item.question}
                        </span>
                        <span className="mt-1 text-xl leading-none text-[#D0D0D0]">
                          {isOpen ? "-" : "+"}
                        </span>
                      </button>

                      {isOpen ? (
                        <div className="border-t border-black px-5 pb-5 pt-4">
                          <FaqAnswer item={item} />
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

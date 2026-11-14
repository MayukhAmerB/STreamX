// /faqs (PHILOSOPHY T-PROSE + accordion, BUILD_PLAN §2.1): grouped questions
// (category pills jump to each group) in native <details> accordions. The
// original answers are kept word for word; the Free tier, Pentesting and plans
// questions are new.
import { Link } from "react-router-dom";

import { FREE_TIER } from "../data/freeLabs";
import { FAQ_PAGE } from "../marketing/marketingContent";
import { ChevronDownIcon, Hand, Tagline } from "../marketing/primitives";

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
    question: "How will I get access after approval?",
    beforeBullets: "Once admin approves your request:",
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
    afterBullets: "You can contact us via WhatsApp or Email.",
  },
  {
    question: "Do you offer refunds?",
    paragraphs: [
      "No, we have a strict no-refund policy.",
      "Since this is a digital course and access credentials (roll number, username, and password) are issued after approval, all confirmed enrollments are final and non-reversible.",
      "We strongly recommend reviewing all course details before requesting access.",
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


export const NEW_FAQ_ITEMS = [
  {
    question: "What can I do for free?",
    paragraphs: [
      "Start with our curated directory of free OSINT challenges on other platforms, follow our learning path through them and track your own progress. The monthly live OSINT CTF is free to enter.",
    ],
    link: { to: FREE_TIER.href, label: "Start free" },
  },
  {
    question: "Is Pentesting open?",
    paragraphs: [
      "Pentesting is coming soon. You can browse every tier, course and module outline now; enrolment, payments and applications open at launch.",
    ],
    link: { to: "/tracks/pentesting", label: "Browse the Pentesting tiers" },
  },
  {
    question: "What are Starter and the CTF Labs membership?",
    paragraphs: [
      "Two monthly plans for the labs. Starter covers the easy and medium labs plus the recorded classes of one batch. The CTF Labs membership covers every lab, new cases each month and that month's recorded course bundle. Both open once their prices are confirmed.",
    ],
    link: { to: "/pricing", label: "See the plans" },
  },
];

export const FAQ_GROUPS = [
  { id: "courses", label: "Courses", questions: ["What is this course about?", "Who is this course for?", "What will I learn in this course?", "Is this course legal and safe to learn?", "Will I get a certificate after completing the course?"] },
  { id: "access", label: "Access", questions: ["How will I get access after approval?", "How does the login system work?", "Can I share my login details with others?", "Do you provide support during the course?"] },
  { id: "payments", label: "Payments", questions: ["Do you offer refunds?"] },
  { id: "plans", label: "Free & plans", questions: NEW_FAQ_ITEMS.map((item) => item.question) },
];

function FaqAnswer({ item }) {
  return (
    <div className="hp-faq__answer">
      {item.paragraphs?.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {item.beforeBullets ? <p>{item.beforeBullets}</p> : null}
      {item.bullets?.length ? (
        <ul className="hp-faq__bullets">
          {item.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      ) : null}
      {item.afterBullets ? <p>{item.afterBullets}</p> : null}
      {item.link ? (
        <p>
          <Link to={item.link.to}>{item.link.label}</Link>
        </p>
      ) : null}
    </div>
  );
}

export default function FaqPage() {
  const all = [...faqItems, ...NEW_FAQ_ITEMS];
  const byQuestion = new Map(all.map((item) => [item.question, item]));
  return (
    <div data-page="faqs">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-faq-title">
        <Tagline>{FAQ_PAGE.tagline}</Tagline>
        <h1 id="hp-faq-title" className="hp-display">
          <span className="hp-display__line">
            {FAQ_PAGE.before} <Hand>{FAQ_PAGE.accent}</Hand>
          </span>
        </h1>
        <p className="hp-lead">{FAQ_PAGE.lead}</p>
        <nav aria-label="Question groups">
          <ul className="hp-chips" style={{ justifyContent: "center" }}>
            {FAQ_GROUPS.map((group) => (
              <li key={group.id}>
                <a className="hp-chip" href={`#faq-${group.id}`}>
                  {group.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </section>
      <div className="hp-frame" style={{ maxWidth: "56rem", paddingBottom: 96 }}>
        {FAQ_GROUPS.map((group, index) => (
          <section key={group.id} id={`faq-${group.id}`} aria-labelledby={`faq-${group.id}-title`} style={{ marginTop: index ? 56 : 0, scrollMarginTop: 88 }}>
            <p className="hp-chapter" id={`faq-${group.id}-title`}>
              {group.label}
            </p>
            <div className="hp-faq">
              {group.questions
                .map((question) => byQuestion.get(question))
                .filter(Boolean)
                .map((item, itemIndex) => (
                  <details key={item.question} open={index === 0 && itemIndex === 0}>
                    <summary>
                      <span>{item.question}</span>
                      <ChevronDownIcon />
                    </summary>
                    <FaqAnswer item={item} />
                  </details>
                ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

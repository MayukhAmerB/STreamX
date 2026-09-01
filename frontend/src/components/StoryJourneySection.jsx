import storyIllustration from "../assets/story-mission.jpg";
import { siteBrand } from "../config/siteBrand";

const journeyBlocks = [
  {
    title: "Our Story",
    body: `Al Syed Initiative is a cybersecurity education and awareness project under the ADL Front (Advanced Digital Lawforce Front), founded by cyber activist Al Syed. It was created to carry forward his work and mindset by building a generation capable of critical thinking, responsible investigation, and confidence in the digital world.

The initiative is built on the belief that knowledge, discipline, and digital awareness are the strongest tools of the modern information age, and that if one voice is silenced, thousands more should be ready to rise. Through training in OSINT, reconnaissance, and web application security, it develops individuals with ethical responsibility, discipline, and investigative thinking.`,
  },
  {
    title: "Our Mission",
    body: `Our mission is to empower individuals to stand against injustice and manipulation in the digital world through digital literacy, ethical hacking, and investigative thinking.

By teaching practical skills in ethical hacking, OSINT research, and security analysis, we aim to build people who think independently, act responsibly, and challenge digital oppression and misinformation, creating a generation that is aware, capable, and courageous in the digital age.`,
  },
];

const owlCognitoJourneyBlocks = [
  {
    title: "Our Approach",
    body: `OwlCognito is a private intelligence learning environment for people who want to investigate public information with care, structure, and professional judgment.

The platform turns research practice into repeatable workflows through guided OSINT, reconnaissance, digital verification, and secure web research training.`,
  },
  {
    title: "Our Standard",
    body: `We teach learners to frame questions carefully, document evidence, validate sources, and respect legal and ethical boundaries.

Every course is designed to turn curiosity into disciplined analytical practice: clear methods, practical exercises, and the confidence to explain how a conclusion was reached.`,
  },
];

export default function StoryJourneySection({ className = "" }) {
  const isOwlCognito = siteBrand.id === "owlcognito";
  const blocks = isOwlCognito ? owlCognitoJourneyBlocks : journeyBlocks;

  return (
    <section
      className={`relative overflow-hidden rounded-[22px] border border-white/10 bg-[#070707] text-[#F4F4F4] shadow-[0_18px_50px_rgba(0,0,0,0.28)] ${className}`}
    >
      <div className="relative z-10 grid lg:grid-cols-[1.1fr_0.9fr]">
        <div className="p-5 sm:p-7 lg:py-8 lg:pl-8 lg:pr-6">
          <div className="inline-flex items-center border-l-2 border-white/60 pl-3 text-xs font-semibold uppercase tracking-[0.18em] text-[#8F8F8F]">
            {isOwlCognito ? "Private intelligence learning" : "Founded in 2026"}
          </div>

          <div className="mt-5 space-y-6">
            {blocks.map((block) => (
              <div key={block.title}>
                <h3 className="font-reference text-3xl font-semibold uppercase leading-tight text-white sm:text-[2.35rem]">
                  {block.title}
                </h3>
                <p className="mt-3 max-w-3xl whitespace-pre-line text-sm leading-7 text-[#A6A6A6] sm:text-base">
                  {block.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative min-h-[340px] overflow-hidden border-t border-white/10 bg-[#050505] lg:min-h-full lg:border-l lg:border-t-0">
          <img
            src={storyIllustration}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-[24px] grayscale"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-black/55" />
          <img
            src={storyIllustration}
            alt="Knowledge is power illustration"
            className="absolute left-1/2 top-1/2 h-auto max-h-[78%] w-auto max-w-[78%] -translate-x-1/2 -translate-y-1/2 object-contain grayscale"
            loading="lazy"
          />
        </div>
      </div>
    </section>
  );
}

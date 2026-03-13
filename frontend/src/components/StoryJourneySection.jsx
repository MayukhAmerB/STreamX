import storyIllustration from "../assets/story-mission.jpg";

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

export default function StoryJourneySection({ className = "" }) {
  return (
    <section
      className={`relative overflow-hidden rounded-[26px] border border-[#222222] bg-[linear-gradient(130deg,#000000_0%,#060606_55%,#0D0D0D_100%)] text-[#F4F4F4] shadow-[0_20px_55px_rgba(0,0,0,0.4)] ${className}`}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(95%_80%_at_100%_0%,rgba(255,255,255,0.12)_0%,rgba(255,255,255,0.05)_28%,rgba(255,255,255,0)_58%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(0,0,0,0)_55%,rgba(255,255,255,0.02)_77%,rgba(255,255,255,0.08)_100%)]" />
      </div>

      <div className="relative z-10 grid lg:grid-cols-[1.1fr_0.9fr]">
        <div className="p-5 sm:p-7 lg:py-8 lg:pl-8 lg:pr-6">
          <div className="inline-flex items-center border-l-2 border-[#D9D9D9] pl-3 text-sm font-medium tracking-wide text-[#BEBEBE]">
            Founded in 2026
          </div>

          <div className="mt-5 space-y-6">
            {journeyBlocks.map((block) => (
              <div key={block.title}>
                <h3 className="font-reference text-4xl font-semibold uppercase leading-tight text-white sm:text-[2.6rem]">
                  {block.title}
                </h3>
                <p className="mt-3 max-w-3xl whitespace-pre-line text-sm leading-7 text-[#C8C8C8] sm:text-base">
                  {block.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative min-h-[340px] overflow-hidden border-t border-[#1F1F1F] lg:min-h-full lg:border-l lg:border-t-0">
          <img
            src={storyIllustration}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-110 object-cover opacity-70 blur-[18px]"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-black/28" />
          <img
            src={storyIllustration}
            alt="Knowledge is power illustration"
            className="absolute left-1/2 top-1/2 h-auto max-h-[82%] w-auto max-w-[82%] -translate-x-1/2 -translate-y-1/2 object-contain"
            loading="lazy"
          />
        </div>
      </div>
    </section>
  );
}

const storyIllustration =
  "https://i.pinimg.com/736x/7e/ef/46/7eef463e943f15d31e296ad596b00080.jpg";

const journeyBlocks = [
  {
    title: "Our Story",
    body: "Al syed Initiative was built by people who genuinely love cybersecurity. We focus on structured training in OSINT, reconnaissance, and web application penetration testing because we believe deep curiosity and disciplined practice are what make this field meaningful.",
  },
  {
    title: "Our Mission",
    body: "Our mission is to nurture passion for cybersecurity through clear structure, ethical testing habits, and evidence-driven thinking. We want every learner to enjoy the process of discovery, analysis, and responsible security practice.",
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
                <p className="mt-3 max-w-3xl text-sm leading-7 text-[#C8C8C8] sm:text-base">
                  {block.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative min-h-[340px] overflow-hidden border-t border-[#1F1F1F] lg:min-h-full lg:border-l lg:border-t-0">
          <img
            src={storyIllustration}
            alt="Knowledge is power illustration"
            className="absolute inset-0 h-full w-full object-cover object-center"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.05)_0%,rgba(0,0,0,0.45)_100%)]" />
        </div>
      </div>
    </section>
  );
}

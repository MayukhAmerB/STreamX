import PageShell from "../components/PageShell";

const certifiedBatches = [
  {
    name: "Batch 1",
    students: ["Araxis", "Al Haris", "Zulqarnain", "Orvax", "Ibn Adam"],
  },
  {
    name: "Batch 2",
    students: [
      "ALHaq",
      "Bani Adam",
      "Baseej",
      "Fly-Nightingale",
      "Jarvis",
      "Khalid",
      "Laisullah",
      "LegallyStalking",
      "RadicalGates",
      "Shaikh Sahab",
      "Spectre",
      "STOIC MURDOCK",
      "Vision",
      "Yamach",
    ],
  },
];

function LaurelsMark() {
  return (
    <svg viewBox="0 0 96 96" className="h-full w-full" aria-hidden="true">
      <defs>
        <linearGradient id="hall-gold" x1="10" y1="8" x2="84" y2="88" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFF1A8" />
          <stop offset="0.3" stopColor="#C99524" />
          <stop offset="0.65" stopColor="#F4D777" />
          <stop offset="1" stopColor="#805A0A" />
        </linearGradient>
      </defs>
      <circle cx="48" cy="48" r="27" fill="none" stroke="url(#hall-gold)" strokeWidth="1.5" />
      <path
        d="M37 58c-8-5-13-13-13-23m9 31c-12-6-20-18-20-32m46 24c8-5 13-13 13-23m-9 31c12-6 20-18 20-32"
        fill="none"
        stroke="url(#hall-gold)"
        strokeLinecap="round"
        strokeWidth="2"
      />
      <path
        d="m48 29 4.3 8.8 9.7 1.4-7 6.8 1.7 9.6-8.7-4.5-8.7 4.5L41 46l-7-6.8 9.7-1.4L48 29Z"
        fill="url(#hall-gold)"
      />
      <path d="M34 69c8 5 20 7 28 0" fill="none" stroke="url(#hall-gold)" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

export default function HallOfFamePage() {
  return (
    <PageShell containerClassName="hall-of-fame-page">
      <section className="relative overflow-hidden rounded-[22px] border border-[#4A3A16] bg-[#080704] px-4 py-7 shadow-[0_24px_70px_rgba(0,0,0,0.45)] sm:rounded-[30px] sm:px-8 sm:py-14 sm:shadow-[0_30px_90px_rgba(0,0,0,0.48)] lg:px-12">
        <div className="pointer-events-none absolute inset-0 hall-of-fame-atmosphere" aria-hidden="true" />
        <div className="pointer-events-none absolute left-1/2 top-0 h-px w-3/5 -translate-x-1/2 bg-gradient-to-r from-transparent via-[#E8C567]/80 to-transparent" aria-hidden="true" />

        <div className="relative mx-auto max-w-4xl text-center">
          <div className="mx-auto h-16 w-16 sm:h-24 sm:w-24">
            <LaurelsMark />
          </div>
          <p className="mt-4 text-[9px] font-semibold uppercase tracking-[0.28em] text-[#B99A52] sm:mt-5 sm:text-xs sm:tracking-[0.32em]">
            Certified Excellence
          </p>
          <h1 className="mt-3 text-[2.15rem] font-extrabold uppercase leading-[0.95] tracking-[-0.045em] text-white sm:mt-4 sm:text-6xl lg:text-7xl">
            Hall of Fame
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-[13px] leading-6 text-[#AAA28F] sm:mt-5 sm:text-base sm:leading-7">
            A permanent record of students who have met the certification standard through skill,
            discipline, and determined investigation.
          </p>
          <div className="mx-auto mt-6 flex max-w-xl items-center gap-3 sm:mt-8 sm:gap-4" aria-hidden="true">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[#7D642B]" />
            <span className="h-1.5 w-1.5 rotate-45 border border-[#D7B95F] bg-[#241B08]" />
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[#7D642B]" />
          </div>
        </div>

        <div className="relative mt-8 space-y-10 sm:mt-12 sm:space-y-14">
          {certifiedBatches.map((batch, batchIndex) => (
            <section key={batch.name} aria-labelledby={`hall-${batch.name.toLowerCase().replace(" ", "-")}`}>
              <div className="mb-4 grid grid-cols-[auto_1fr_auto] items-center gap-3 sm:mb-6 sm:gap-4">
                <h2
                  id={`hall-${batch.name.toLowerCase().replace(" ", "-")}`}
                  className="shrink-0 text-[11px] font-bold uppercase tracking-[0.22em] text-[#D7B95F] sm:text-sm sm:tracking-[0.28em]"
                >
                  {batch.name}
                </h2>
                <span className="h-px flex-1 bg-gradient-to-r from-[#6A5222] to-transparent" aria-hidden="true" />
                <span className="whitespace-nowrap text-[8px] font-semibold uppercase tracking-[0.14em] text-[#766A50] sm:text-[10px] sm:tracking-[0.2em]">
                  {batch.students.length} certified
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
                {batch.students.map((student, index) => (
                  <article
                    key={student}
                    className="hall-of-fame-card group relative min-h-[8.75rem] overflow-hidden rounded-[18px] border border-[#3E321A] bg-[#0C0B08] p-4 sm:min-h-44 sm:rounded-2xl sm:p-6"
                    style={{ "--hall-delay": `${Math.min(batchIndex * 2 + index, 8) * 55}ms` }}
                  >
                    <div className="pointer-events-none absolute inset-0 hall-of-fame-card-glow" aria-hidden="true" />
                    <div className="relative flex h-full flex-col justify-between gap-5 sm:gap-8">
                      <div className="flex items-start justify-between gap-4">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#5C4820] bg-[#161207] text-[#D5B65F] sm:h-9 sm:w-9">
                          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                            <path d="m12 3 2.5 5.1 5.6.8-4 3.9.9 5.5-5-2.6-5 2.6.9-5.5-4-3.9 5.6-.8L12 3Z" fill="currentColor" />
                          </svg>
                        </span>
                        <span className="text-right text-[8px] font-semibold uppercase tracking-[0.16em] text-[#766A50] sm:text-[9px] sm:tracking-[0.22em]">
                          Certified Student
                        </span>
                      </div>
                      <div>
                        <h3 className="hall-of-fame-gold [overflow-wrap:anywhere] text-[1.35rem] font-bold leading-tight tracking-[-0.025em] sm:text-[1.7rem]">
                          {student}
                        </h3>
                        <div className="mt-3 h-px w-12 bg-gradient-to-r from-[#D8B653] to-transparent transition-all duration-500 group-hover:w-24 sm:mt-4" aria-hidden="true" />
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="relative mt-8 rounded-[18px] border border-[#312817] bg-black/25 px-4 py-4 text-center sm:mt-12 sm:rounded-2xl sm:px-8 sm:py-5">
          <p className="text-[9px] font-semibold uppercase leading-5 tracking-[0.16em] text-[#9B844D] sm:text-xs sm:tracking-[0.22em]">
            Earned through knowledge. Remembered through excellence.
          </p>
        </div>
      </section>
    </PageShell>
  );
}

import PageShell from "../components/PageShell";

const certifiedBatches = [
  {
    name: "Batch 1",
    students: ["Al Bashar", "MalakulMaut"],
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
      <section className="relative overflow-hidden rounded-[30px] border border-[#4A3A16] bg-[#080704] px-5 py-10 shadow-[0_30px_90px_rgba(0,0,0,0.48)] sm:px-8 sm:py-14 lg:px-12">
        <div className="pointer-events-none absolute inset-0 hall-of-fame-atmosphere" aria-hidden="true" />
        <div className="pointer-events-none absolute left-1/2 top-0 h-px w-3/5 -translate-x-1/2 bg-gradient-to-r from-transparent via-[#E8C567]/80 to-transparent" aria-hidden="true" />

        <div className="relative mx-auto max-w-4xl text-center">
          <div className="mx-auto h-20 w-20 sm:h-24 sm:w-24">
            <LaurelsMark />
          </div>
          <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.32em] text-[#B99A52] sm:text-xs">
            Certified Excellence
          </p>
          <h1 className="mt-4 text-4xl font-extrabold uppercase leading-none tracking-[-0.045em] text-white sm:text-6xl lg:text-7xl">
            Hall of Fame
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-sm leading-7 text-[#AAA28F] sm:text-base">
            A permanent record of students who have met the certification standard through skill,
            discipline, and determined investigation.
          </p>
          <div className="mx-auto mt-8 flex max-w-xl items-center gap-4" aria-hidden="true">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-[#7D642B]" />
            <span className="h-1.5 w-1.5 rotate-45 border border-[#D7B95F] bg-[#241B08]" />
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-[#7D642B]" />
          </div>
        </div>

        <div className="relative mt-10 space-y-12 sm:mt-12 sm:space-y-14">
          {certifiedBatches.map((batch, batchIndex) => (
            <section key={batch.name} aria-labelledby={`hall-${batch.name.toLowerCase().replace(" ", "-")}`}>
              <div className="mb-5 flex items-center gap-4 sm:mb-6">
                <h2
                  id={`hall-${batch.name.toLowerCase().replace(" ", "-")}`}
                  className="shrink-0 text-xs font-bold uppercase tracking-[0.28em] text-[#D7B95F] sm:text-sm"
                >
                  {batch.name}
                </h2>
                <span className="h-px flex-1 bg-gradient-to-r from-[#6A5222] to-transparent" aria-hidden="true" />
                <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#766A50] sm:text-[10px]">
                  {batch.students.length} certified
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {batch.students.map((student, index) => (
                  <article
                    key={student}
                    className="hall-of-fame-card group relative min-h-44 overflow-hidden rounded-2xl border border-[#3E321A] bg-[#0C0B08] p-5 sm:p-6"
                    style={{ "--hall-delay": `${(batchIndex * 4 + index) * 75}ms` }}
                  >
                    <div className="pointer-events-none absolute inset-0 hall-of-fame-card-glow" aria-hidden="true" />
                    <div className="relative flex h-full flex-col justify-between gap-8">
                      <div className="flex items-start justify-between gap-4">
                        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#5C4820] bg-[#161207] text-[#D5B65F]">
                          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                            <path d="m12 3 2.5 5.1 5.6.8-4 3.9.9 5.5-5-2.6-5 2.6.9-5.5-4-3.9 5.6-.8L12 3Z" fill="currentColor" />
                          </svg>
                        </span>
                        <span className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#766A50]">
                          Certified Student
                        </span>
                      </div>
                      <div>
                        <h3 className="hall-of-fame-gold break-words text-2xl font-bold leading-tight tracking-[-0.025em] sm:text-[1.7rem]">
                          {student}
                        </h3>
                        <div className="mt-4 h-px w-12 bg-gradient-to-r from-[#D8B653] to-transparent transition-all duration-500 group-hover:w-24" aria-hidden="true" />
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="relative mt-10 rounded-2xl border border-[#312817] bg-black/25 px-5 py-5 text-center sm:mt-12 sm:px-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9B844D] sm:text-xs">
            Earned through knowledge. Remembered through excellence.
          </p>
        </div>
      </section>
    </PageShell>
  );
}

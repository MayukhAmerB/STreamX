import PageShell from "../components/PageShell";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const pillars = [
  {
    title: "Practical First",
    body: "We focus on workflows you can apply in real assessments, not just tool demos.",
    stat: "Hands-on",
  },
  {
    title: "Structured Learning",
    body: "Clear module progression helps learners build confidence step by step.",
    stat: "Step-by-step",
  },
  {
    title: "Professional Mindset",
    body: "We emphasize ethical testing, documentation quality, and repeatable methodology.",
    stat: "Workflow-first",
  },
];

export default function AboutPage() {
  return (
    <PageShell
      title="About Us"
      subtitle="Al syed Initiative helps learners build practical cybersecurity skills with structured training."
    >
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[28px] border border-black bg-[#080808] shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.17]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/85 via-black/78 to-[#111111]/92" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(192,192,192,0.14),transparent_38%)]" />
        </div>

        <div className="relative p-5 sm:p-7">
          <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <section className="rounded-2xl border border-black panel-gradient p-6 backdrop-blur-sm">
              <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-wide text-[#DBDBDB]">
                ABOUT AL SYED INITIATIVE
              </div>
              <h2 className="mt-4 font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
                Practical cybersecurity learning built for real execution
              </h2>
              <p className="mt-4 text-sm leading-7 text-[#BBBBBB]">
                Al syed Initiative is a cybersecurity learning platform focused on practical training in
                OSINT, reconnaissance, and web application penetration testing. We design lessons
                for learners who want a clear path from fundamentals to professional execution.
              </p>
              <p className="mt-4 text-sm leading-7 text-[#BBBBBB]">
                Our goal is to teach repeatable workflows, disciplined testing habits, and strong
                reporting practices so students can move beyond theory and apply their skills
                confidently.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-black panel-gradient p-3">
                  <div className="font-reference text-lg font-semibold text-[#DFDFDF]">OSINT</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#949494]">
                    Research workflows
                  </div>
                </div>
                <div className="rounded-xl border border-black panel-gradient p-3">
                  <div className="font-reference text-lg font-semibold text-[#DFDFDF]">Recon</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#949494]">
                    Surface mapping
                  </div>
                </div>
                <div className="rounded-xl border border-black panel-gradient p-3">
                  <div className="font-reference text-lg font-semibold text-[#DFDFDF]">Web App</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#949494]">
                    Pentesting flow
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-black panel-gradient p-6 backdrop-blur-sm">
              <h2 className="font-reference text-2xl font-semibold text-white">What We Teach</h2>
              <p className="mt-3 text-sm leading-6 text-[#BBBBBB]">
                We focus on the parts that help learners think and operate like professionals.
              </p>
              <ul className="mt-5 space-y-3">
                {[
                  "OSINT research and target profiling",
                  "Reconnaissance and attack surface mapping",
                  "Web application penetration testing workflows",
                  "Documentation and evidence-driven reporting",
                ].map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 rounded-xl border border-black panel-gradient px-4 py-3 text-sm text-[#C8C8C8]"
                  >
                    <span className="mt-1 inline-flex h-2.5 w-2.5 rounded-full bg-[#C0C0C0]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5 rounded-xl border border-black bg-gradient-to-r from-[#161616] to-[#121212] p-4">
                <div className="font-reference text-sm font-semibold text-[#DFDFDF]">
                  Learning Philosophy
                </div>
                <p className="mt-2 text-sm leading-6 text-[#B3B3B3]">
                  Learn methodology, apply it repeatedly, document evidence clearly, and improve
                  through structured practice.
                </p>
              </div>
            </section>
          </div>

          <section className="mt-6 rounded-2xl border border-black panel-gradient p-6 backdrop-blur-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-reference text-2xl font-semibold text-white">
                  Why Students Choose Us
                </h2>
                <p className="mt-2 text-sm text-[#BBBBBB]">
                  Clear structure, practical depth, and a workflow-first teaching style.
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              {pillars.map((pillar) => (
                <div
                  key={pillar.title}
                  className="group rounded-xl border border-black panel-gradient p-4 transition hover:border-[#3F3F3F] hover:bg-[#171717]"
                >
                  <div className="inline-flex rounded-full border border-black bg-white/5 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-[#DBDBDB]">
                    {pillar.stat}
                  </div>
                  <h3 className="mt-3 font-reference text-lg font-semibold text-[#E0E0E0]">
                    {pillar.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">{pillar.body}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  );
}


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
      subtitle="AlsyedAcademy helps learners build practical cybersecurity skills with structured training."
    >
      <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[28px] border border-[#cfd8c5]/10 bg-[#070907] shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.17]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/85 via-black/78 to-[#0d130f]/92" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(185,199,171,0.14),transparent_38%)]" />
        </div>

        <div className="relative p-5 sm:p-7">
          <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <section className="rounded-2xl border border-[#243025] bg-[#0d120f]/92 p-6 backdrop-blur-sm">
              <div className="inline-flex items-center rounded-full border border-[#334033] bg-white/5 px-3 py-1 text-xs font-semibold tracking-wide text-[#d7e0cc]">
                ABOUT ALSYEDACADEMY
              </div>
              <h2 className="mt-4 font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
                Practical cybersecurity learning built for real execution
              </h2>
              <p className="mt-4 text-sm leading-7 text-[#b7c0b0]">
                AlsyedAcademy is a cybersecurity learning platform focused on practical training in
                OSINT, reconnaissance, and web application penetration testing. We design lessons
                for learners who want a clear path from fundamentals to professional execution.
              </p>
              <p className="mt-4 text-sm leading-7 text-[#b7c0b0]">
                Our goal is to teach repeatable workflows, disciplined testing habits, and strong
                reporting practices so students can move beyond theory and apply their skills
                confidently.
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-[#202820] bg-[#101610] p-3">
                  <div className="font-reference text-lg font-semibold text-[#dbe4d0]">OSINT</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#8f9989]">
                    Research workflows
                  </div>
                </div>
                <div className="rounded-xl border border-[#202820] bg-[#101610] p-3">
                  <div className="font-reference text-lg font-semibold text-[#dbe4d0]">Recon</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#8f9989]">
                    Surface mapping
                  </div>
                </div>
                <div className="rounded-xl border border-[#202820] bg-[#101610] p-3">
                  <div className="font-reference text-lg font-semibold text-[#dbe4d0]">Web App</div>
                  <div className="mt-1 text-xs uppercase tracking-wide text-[#8f9989]">
                    Pentesting flow
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-[#243025] bg-[#0d120f]/90 p-6 backdrop-blur-sm">
              <h2 className="font-reference text-2xl font-semibold text-white">What We Teach</h2>
              <p className="mt-3 text-sm leading-6 text-[#b7c0b0]">
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
                    className="flex items-start gap-3 rounded-xl border border-[#1f2820] bg-[#101610] px-4 py-3 text-sm text-[#c4cdba]"
                  >
                    <span className="mt-1 inline-flex h-2.5 w-2.5 rounded-full bg-[#b9c7ab]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-5 rounded-xl border border-[#2b372b] bg-gradient-to-r from-[#121912] to-[#0f1410] p-4">
                <div className="font-reference text-sm font-semibold text-[#dbe4d0]">
                  Learning Philosophy
                </div>
                <p className="mt-2 text-sm leading-6 text-[#aeb8a8]">
                  Learn methodology, apply it repeatedly, document evidence clearly, and improve
                  through structured practice.
                </p>
              </div>
            </section>
          </div>

          <section className="mt-6 rounded-2xl border border-[#243025] bg-[#0d120f]/92 p-6 backdrop-blur-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="font-reference text-2xl font-semibold text-white">
                  Why Students Choose Us
                </h2>
                <p className="mt-2 text-sm text-[#b7c0b0]">
                  Clear structure, practical depth, and a workflow-first teaching style.
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-3">
              {pillars.map((pillar) => (
                <div
                  key={pillar.title}
                  className="group rounded-xl border border-[#1f2820] bg-[#101610] p-4 transition hover:border-[#364536] hover:bg-[#131a13]"
                >
                  <div className="inline-flex rounded-full border border-[#cfd8c5]/20 bg-white/5 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-[#d7e0cc]">
                    {pillar.stat}
                  </div>
                  <h3 className="mt-3 font-reference text-lg font-semibold text-[#dce5d2]">
                    {pillar.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">{pillar.body}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

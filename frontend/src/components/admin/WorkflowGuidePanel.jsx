export default function WorkflowGuidePanel({ title, subtitle, steps }) {
  return (
    <section className="rounded-2xl border border-[#253126] bg-[#0b110b]/90 p-4 shadow-[0_16px_34px_rgba(0,0,0,0.26)] sm:p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8f9989]">{title}</div>
      {subtitle ? <p className="mt-2 text-sm text-[#b7c0b0]">{subtitle}</p> : null}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {steps.map((step, index) => (
          <article key={step.title} className="rounded-xl border border-[#1f2820] bg-[#101710]/95 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#d8e1cf]">
              {`0${index + 1} ${step.title}`}
            </div>
            <p className="mt-2 text-xs leading-6 text-[#b4bead]">{step.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

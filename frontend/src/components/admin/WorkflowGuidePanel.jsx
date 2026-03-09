export default function WorkflowGuidePanel({ title, subtitle, steps }) {
  return (
    <section className="rounded-2xl border border-black panel-gradient p-4 shadow-[0_16px_34px_rgba(0,0,0,0.26)] sm:p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#949494]">{title}</div>
      {subtitle ? <p className="mt-2 text-sm text-[#BBBBBB]">{subtitle}</p> : null}
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {steps.map((step, index) => (
          <article key={step.title} className="rounded-xl border border-black panel-gradient p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#DCDCDC]">
              {`0${index + 1} ${step.title}`}
            </div>
            <p className="mt-2 text-xs leading-6 text-[#B9B9B9]">{step.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

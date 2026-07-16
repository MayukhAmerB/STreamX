import DecryptedText from "./DecryptedText";

export default function PageShell({
  title,
  subtitle,
  action,
  badge,
  children,
  decryptTitle = false,
  containerClassName = "",
}) {
  return (
    <section
      className={`mx-auto max-w-7xl px-3 py-6 text-white sm:px-5 sm:py-12 lg:px-6 ${containerClassName}`.trim()}
    >
      {(title || subtitle || action) && (
        <div className="relative mb-6 border-b border-white/10 pb-5 sm:mb-8 sm:pb-7">
          <span className="absolute -bottom-px left-0 h-px w-24 bg-white/70" aria-hidden="true" />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            {title ? (
              <div>
                {badge ? (
                  <div className="mb-3 inline-flex items-center rounded-full border border-white/20 bg-white/[0.06] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#CFCFCF] sm:mb-4 sm:tracking-[0.18em]">
                    {badge}
                  </div>
                ) : null}
                <div className="mb-3 h-1 w-10 rounded-full bg-white/70 sm:mb-4" aria-hidden="true" />
                <h1 className="max-w-4xl text-[1.75rem] font-extrabold leading-[1.08] tracking-[-0.035em] text-white sm:text-[2.6rem]">
                  {decryptTitle ? <DecryptedText text={title} /> : title}
                </h1>
                {subtitle ? <p className="mt-3 max-w-3xl text-sm leading-6 text-[#949494] sm:text-base sm:leading-7">{subtitle}</p> : null}
              </div>
            ) : null}
            {!title && subtitle ? <p className="text-sm leading-7 text-[#BBBBBB]">{subtitle}</p> : null}
            {action ? <div className="w-full sm:w-auto [&>*]:w-full sm:[&>*]:w-auto">{action}</div> : null}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}


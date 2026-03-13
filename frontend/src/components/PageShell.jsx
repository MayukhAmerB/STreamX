import DecryptedText from "./DecryptedText";

export default function PageShell({ title, subtitle, action, badge, children, decryptTitle = false }) {
  return (
    <section className="mx-auto max-w-7xl px-4 py-8 text-white sm:px-5 lg:px-6">
      {(title || subtitle || action) && (
        <div className="relative mb-6 overflow-hidden rounded-3xl border border-black panel-gradient p-5 shadow-[0_22px_60px_rgba(0,0,0,0.3)] backdrop-blur-sm sm:p-6">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_8%,rgba(192,192,192,0.14),transparent_35%)]" />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            {title ? (
              <div>
                {badge ? (
                  <div className="mb-3 inline-flex items-center rounded-full border border-black panel-gradient px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#DBDBDB]">
                    {badge}
                  </div>
                ) : null}
                <h1 className="text-3xl font-black tracking-tight text-white sm:text-[2.2rem]">
                  {decryptTitle ? <DecryptedText text={title} /> : title}
                </h1>
                {subtitle ? <p className="mt-2 max-w-3xl text-sm leading-7 text-[#BBBBBB]">{subtitle}</p> : null}
              </div>
            ) : null}
            {!title && subtitle ? <p className="text-sm leading-7 text-[#BBBBBB]">{subtitle}</p> : null}
            {action}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}


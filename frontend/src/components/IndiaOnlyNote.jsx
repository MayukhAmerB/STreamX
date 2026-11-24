// "Only for Indians" remark: shown on the landing page, the Contact page and the
// footer contact section so every visitor sees it before buying or writing in.
export const INDIA_ONLY_LABEL = "Only for Indians";
export const INDIA_ONLY_DETAIL = "Our courses, live classes and support are available only to learners in India.";

export default function IndiaOnlyNote({ variant = "pill", className = "" }) {
  if (variant === "pill") {
    return (
      <p
        className={`inline-flex items-center gap-2 rounded-full border border-[#f3e2b3]/40 bg-[#f3e2b3]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#f3e2b3] ${className}`}
        title={INDIA_ONLY_DETAIL}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[#f3e2b3]" aria-hidden="true" />
        {INDIA_ONLY_LABEL}
      </p>
    );
  }
  return (
    <p
      role="note"
      className={`rounded-xl border border-[#f3e2b3]/35 bg-[#f3e2b3]/[0.07] px-4 py-3 text-sm leading-6 text-[#E8E8E8] ${className}`}
    >
      <strong className="mr-2 font-bold uppercase tracking-[0.14em] text-[#f3e2b3]">{INDIA_ONLY_LABEL}.</strong>
      {INDIA_ONLY_DETAIL}
    </p>
  );
}

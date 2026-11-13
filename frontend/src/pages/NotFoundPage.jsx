import { Link } from "react-router-dom";

/** Unknown website address: a real "not found" page (kept out of search via the page meta). */
export default function NotFoundPage() {
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-start justify-center px-4 py-16 text-white sm:px-6">
      <p className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.24em] text-[#A3A3A3]">
        <span className="h-px w-10 bg-white/65" aria-hidden="true" />
        Error 404
      </p>
      <h1 className="mt-5 text-[clamp(2.2rem,7vw,3.6rem)] font-extrabold leading-[1] tracking-[-0.045em]">
        This page could not be found.
      </h1>
      <p className="mt-5 max-w-xl text-base leading-7 text-[#A7A7A7]">
        The link may be old or mistyped. Everything on the site is still a click away.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          to="/"
          className="inline-flex min-h-12 items-center justify-center rounded-lg bg-white px-6 text-sm font-semibold text-black transition hover:bg-[#E5E5E5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        >
          Go to the home page
        </Link>
        <Link
          to="/courses"
          className="inline-flex min-h-12 items-center justify-center rounded-lg border border-white/20 bg-[#090909] px-6 text-sm font-semibold text-white transition hover:border-white/40 hover:bg-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3]"
        >
          Browse courses
        </Link>
        <Link
          to="/contact"
          className="inline-flex min-h-12 items-center justify-center rounded-lg px-4 text-sm font-semibold text-[#D9D9D9] underline decoration-white/25 underline-offset-4 transition hover:text-white"
        >
          Contact us
        </Link>
      </div>
    </section>
  );
}

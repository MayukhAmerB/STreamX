import { Link } from "react-router-dom";

import Button from "./Button";

export default function OsintToolsAccessCard({ className = "" }) {
  return (
    <section
      className={`overflow-hidden rounded-[24px] border border-white/15 bg-[#101010] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.24)] sm:p-6 ${className}`.trim()}
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <div className="inline-flex rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#DBDBDB]">
            Included Student Resource
          </div>
          <h2 className="mt-3 font-reference text-2xl font-semibold text-white">
            OSINT Tools Library
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-7 text-[#BBBBBB]">
            Your OSINT course includes the categorized tools reference, guided tool finder, and
            practical descriptions for identity, metadata, archives, images, infrastructure, and
            behavioral analysis.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
          <Link to="/osint-tools#beginner-tool-finder" className="inline-flex">
            <Button className="w-full sm:w-auto">Beginner Tool Finder</Button>
          </Link>
          <Link to="/osint-tools" className="inline-flex">
            <Button variant="secondary" className="w-full sm:w-auto">
              Open Tools Library
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}

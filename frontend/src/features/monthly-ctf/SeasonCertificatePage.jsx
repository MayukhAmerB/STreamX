// Public verification of a Monthly CTF Finalist certificate
// (/monthly-ctf/certificates/:slug). OWNER: WS-MONTHLY-CTF.
//
// Anyone with the link can check it (no sign-in; works even while the switch
// is off). Status is icon + word: "Verified" (solid) or "Revoked" (dashed).
// The certificate is greyscale with one golden-white seal; it prints on white.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { StatusBadge } from "../../kit/Badge";
import { Button } from "../../kit/Button";
import { Frame, Notice, Section } from "../../kit/Layout";
import { siteBrand } from "../../config/siteBrand";
import { TrophyMark } from "./Cosmetics";
import { fetchCertificate } from "./seasonApi";
import { HALL_OF_FAME_PATH, formatIst, ordinal } from "./seasonModel";
import { useLoad } from "./SeasonParts";

function CopyLink() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <Button variant="secondary" size="md" onClick={copy}>
        {copied ? "Link copied" : "Copy link"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Certificate link copied." : ""}
      </span>
    </>
  );
}

export default function SeasonCertificatePage() {
  const { slug = "" } = useParams();
  const cert = useLoad(() => fetchCertificate(slug), [slug]);
  const data = cert.state === "ready" ? cert.data : null;

  return (
    <div className="bg-background text-foreground">
      <Section rhythm="none" className="px-0 pb-20 pt-28 md:pt-32">
        <Frame width="narrow">
          {cert.state === "loading" ? (
            <p className="text-center text-sm text-subtle" role="status">
              Checking the certificate…
            </p>
          ) : null}
          {cert.state === "missing" ? (
            <Notice eyebrow="Not found" title="We could not find this certificate" role="alert">
              Check that the link is complete. Certificates are issued to the top ten of each Monthly CTF season.
            </Notice>
          ) : null}
          {cert.state === "error" || cert.state === "off" ? (
            <Notice eyebrow="Could not check" title="The certificate did not load" role="alert">
              Reload the page to try again.
            </Notice>
          ) : null}
          {data ? (
            <>
              <div className="mctf-no-print mb-6 flex flex-wrap items-center justify-center gap-3">
                <StatusBadge kind={data.valid ? "done" : "disabled"} label={data.valid ? "Verified" : "Revoked"} size="md" />
                <span className="text-sm text-subtle">
                  {data.valid ? `Issued by ${siteBrand.name}` : "This certificate was withdrawn and is no longer valid."}
                </span>
              </div>
              <article
                className="mctf-certificate relative overflow-hidden rounded-2xl border border-white/15 bg-card px-6 py-12 text-center sm:px-14 sm:py-16"
                aria-labelledby="mctf-cert-title"
              >
                <span aria-hidden="true" className="pointer-events-none absolute inset-3 rounded-xl border border-white/[.06]" />
                <p className="text-kicker uppercase text-subtle">{siteBrand.name} · Monthly OSINT CTF</p>
                <h1 id="mctf-cert-title" className="mt-6 font-hand text-4xl text-white sm:text-5xl">
                  Certificate of Finalist
                </h1>
                <p className="mt-8 text-sm text-muted-foreground">This certifies that</p>
                <p className="mt-2 break-words text-3xl font-semibold text-white sm:text-4xl">{data.name}</p>
                <p className="mx-auto mt-6 max-w-md text-base leading-7 text-[#d4d4d4]">
                  finished <strong className="font-semibold text-white">{ordinal(data.rank)}</strong> in the {data.month} season,
                  &ldquo;{data.season_title}&rdquo;, among the top ten investigators of the month.
                </p>
                <div className="mt-10 flex items-center justify-center">
                  <TrophyMark tier={data.rank === 1 ? "gold" : data.rank === 2 ? "silver" : data.rank === 3 ? "bronze" : "gold"} star={data.rank === 1} size={56} />
                </div>
                <dl className="mt-10 grid gap-4 border-t border-white/10 pt-6 text-left text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-subtle">Issued</dt>
                    <dd className="mt-1 text-white">{formatIst(data.issued_at, { withTime: false })}</dd>
                  </div>
                  <div className="sm:text-right">
                    <dt className="text-subtle">Certificate ID</dt>
                    <dd className="mt-1 break-all font-mono text-white">{data.slug}</dd>
                  </div>
                </dl>
              </article>
              <div className="mctf-no-print mt-8 flex flex-wrap justify-center gap-3">
                <Button size="md" onClick={() => window.print()}>
                  Print or save as PDF
                </Button>
                <CopyLink />
                <Button asChild variant="ghost" size="md">
                  <Link to={HALL_OF_FAME_PATH}>Hall of Fame</Link>
                </Button>
              </div>
            </>
          ) : null}
        </Frame>
      </Section>
    </div>
  );
}

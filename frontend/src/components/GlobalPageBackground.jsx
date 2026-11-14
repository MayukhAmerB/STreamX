/**
 * The public canvas (PHILOSOPHY §1.1): pure black, no glows or gradients.
 * Kept as a fixed layer so overscroll and short pages stay black on every
 * brand (one monochrome system, BUILD_PLAN D11).
 */
export default function GlobalPageBackground() {
  return <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 bg-black" />;
}

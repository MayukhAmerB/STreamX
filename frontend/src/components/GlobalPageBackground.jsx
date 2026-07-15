export default function GlobalPageBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0 bg-black" />
      <div className="absolute inset-0 bg-[radial-gradient(70%_55%_at_82%_0%,rgba(255,255,255,0.055)_0%,rgba(255,255,255,0.012)_42%,transparent_72%)]" />
    </div>
  );
}

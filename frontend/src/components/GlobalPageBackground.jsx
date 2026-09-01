import { siteBrand } from "../config/siteBrand";

export default function GlobalPageBackground() {
  const isOwlCognito = siteBrand.id === "owlcognito";

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className={`absolute inset-0 ${isOwlCognito ? "bg-[#fbfaff]" : "bg-black"}`} />
      <div
        className={`absolute inset-0 ${
          isOwlCognito
            ? "bg-[radial-gradient(70%_55%_at_82%_0%,rgba(139,92,246,0.26)_0%,rgba(221,214,254,0.46)_42%,transparent_72%)]"
            : "bg-[radial-gradient(70%_55%_at_82%_0%,rgba(255,255,255,0.055)_0%,rgba(255,255,255,0.012)_42%,transparent_72%)]"
        }`}
      />
    </div>
  );
}

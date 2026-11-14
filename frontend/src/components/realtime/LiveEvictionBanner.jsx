import Button from "../Button";

// Shown instead of the blocking "signed in on another device" dialog while a
// live class is playing on this device (Phase 2, D5): the class continues
// here until it ends; the student may switch devices or sign out any time.
export default function LiveEvictionBanner({ signingOut = false, onUseThisDevice, onSignOut }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="live-eviction-banner"
      className="fixed inset-x-0 top-0 z-[1100] border-b border-amber-300/40 bg-[#2b1d00]/95 px-4 py-3 text-[#FCEFC7] shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6">
          <span className="font-semibold">Signed in on another device.</span> This class will keep playing here
          until it ends. After that, this device will be signed out.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" disabled={signingOut} onClick={onUseThisDevice}>
            Use this device instead
          </Button>
          <Button type="button" variant="secondary" loading={signingOut} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

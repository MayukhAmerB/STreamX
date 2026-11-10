import Button from "./Button";

// Shown over the current page when another device took this session. It never
// unmounts or navigates the page underneath, so a playing class keeps playing
// until the student chooses what to do.
export default function SessionEvictedDialog({ open, signingOut = false, onUseThisDevice, onSignOut }) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-evicted-title"
        aria-describedby="session-evicted-description"
        className="w-full max-w-md rounded-[20px] border border-white/15 bg-[#080808] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-[0_32px_90px_rgba(0,0,0,0.72)] sm:p-6"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#BDBDBD]">Session ended</p>
        <h2 id="session-evicted-title" className="mt-2 font-reference text-2xl font-semibold text-white">
          You signed in on another device
        </h2>
        <p id="session-evicted-description" className="mt-3 text-sm leading-6 text-[#C7C7C7]">
          Your account is now active on another device, so this one was signed out. Sign in again to keep
          using it here.
        </p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <Button type="button" autoFocus disabled={signingOut} onClick={onUseThisDevice}>
            Use this device
          </Button>
          <Button type="button" variant="secondary" loading={signingOut} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

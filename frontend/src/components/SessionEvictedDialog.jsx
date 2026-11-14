import Button from "./Button";

// What the dialog says. "signed-out": another sign-in took this device's
// session. "live": the same, but this device may still finish the live class
// it was in (it is not on that class right now). "class-ended": that class is
// over, so this device has now been signed out.
const COPY = {
  "signed-out": {
    eyebrow: "Session ended",
    title: "You signed in on another device",
    description:
      "Your account is now active on another device, so this one was signed out. Sign in again to keep using it here.",
    primary: "Use this device",
  },
  live: {
    eyebrow: "Signed in elsewhere",
    title: "You signed in on another device",
    description:
      "Your account is now active on another device. This device can only stay in the live class it was watching, until that class ends. Sign in again to use everything else here.",
    primary: "Use this device",
  },
  "class-ended": {
    eyebrow: "Class ended",
    title: "Your class has ended",
    description:
      "This account is signed in on another device, so this device was signed out when the class ended. Sign in again to keep using it here.",
    primary: "Sign in again",
  },
};

// Shown over the current page when another device took this session. It never
// unmounts or navigates the page underneath, so a playing class keeps playing
// until the student chooses what to do.
export default function SessionEvictedDialog({
  open,
  variant = "signed-out",
  signingOut = false,
  onUseThisDevice,
  onSignOut,
}) {
  if (!open) {
    return null;
  }
  const copy = COPY[variant] || COPY["signed-out"];

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/80 px-4 py-6 backdrop-blur-sm">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-evicted-title"
        aria-describedby="session-evicted-description"
        data-variant={variant}
        className="w-full max-w-md rounded-[10px] border border-white/10 bg-[#0a0a0a] p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:p-8"
      >
        <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">{copy.eyebrow}</p>
        <h2 id="session-evicted-title" className="mt-3 text-3xl font-normal leading-tight text-white">
          {copy.title}
        </h2>
        <p id="session-evicted-description" className="mt-3 text-sm leading-6 text-[#a1a1a1]">
          {copy.description}
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <Button type="button" autoFocus disabled={signingOut} onClick={onUseThisDevice}>
            {copy.primary}
          </Button>
          <Button type="button" variant="secondary" loading={signingOut} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}

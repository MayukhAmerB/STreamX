import { HOST_LINK } from "../../services/realtime/hostStudioController";

const TONE_CLASSES = {
  good: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  warn: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  bad: "border-red-400/40 bg-red-500/10 text-red-200",
  idle: "border-black bg-[#171717] text-[#CDCDCD]",
};

const DOT_CLASSES = {
  good: "bg-emerald-400",
  warn: "bg-amber-400 animate-pulse",
  bad: "bg-red-400",
  idle: "bg-[#6B6B6B]",
};

export function describeStudioLink(link) {
  switch (link) {
    case HOST_LINK.CONNECTING:
      return { tone: "warn", label: "Connecting..." };
    case HOST_LINK.CONNECTED:
      return { tone: "good", label: "Studio connected" };
    case HOST_LINK.RECONNECTING:
      return { tone: "warn", label: "Reconnecting..." };
    case HOST_LINK.REPLACED:
      return { tone: "bad", label: "Taken over by another tab" };
    case HOST_LINK.FAILED:
      return { tone: "bad", label: "Disconnected" };
    default:
      return { tone: "idle", label: "Not connected" };
  }
}

export function describeDelivery({ live, egress }) {
  if (!live) return null;
  if (!egress) return { tone: "warn", label: "Checking delivery..." };
  if (egress.running === true) return { tone: "good", label: "Delivering to viewers" };
  if (egress.running === false) return { tone: "bad", label: "Delivery stopped" };
  return { tone: "warn", label: "Delivery unverified" };
}

function Chip({ tone, label }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] ${TONE_CLASSES[tone]}`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT_CLASSES[tone]}`} />
      {label}
    </span>
  );
}

export default function HostStudioStatusChip({ link, live = false, egress = null }) {
  const linkState = describeStudioLink(link);
  const delivery = describeDelivery({ live, egress });
  return (
    <span role="status" aria-live="polite" className="inline-flex flex-wrap items-center gap-2">
      <Chip tone={linkState.tone} label={linkState.label} />
      {delivery ? <Chip tone={delivery.tone} label={delivery.label} /> : null}
    </span>
  );
}

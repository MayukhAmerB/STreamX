import { HOST_LINK } from "../../services/realtime/hostStudioController";

const TONE_CLASSES = {
  good: "border-white/30 bg-white/[0.06] text-[#fafafa]",
  warn: "border-[#F3E2B3]/40 bg-[#F3E2B3]/10 text-[#F3E2B3]",
  bad: "border-white bg-[#fafafa] text-black",
  idle: "border-black bg-[#171717] text-[#CDCDCD]",
};

const DOT_CLASSES = {
  good: "bg-white",
  warn: "bg-[#F3E2B3] animate-pulse motion-reduce:animate-none",
  bad: "bg-black ring-1 ring-black",
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

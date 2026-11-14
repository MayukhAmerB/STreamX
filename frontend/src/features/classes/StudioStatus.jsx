// The studio's connection and delivery state as words with a dot (never
// colour alone). Reuses the state rules of HostStudioStatus. OWNER: WS-D1.
import { describeDelivery, describeStudioLink } from "../../components/realtime/HostStudioStatus";
import { HOST_LINK } from "../../services/realtime/hostStudioController";

function Pill({ tone, label }) {
  return (
    <span className={`cls-pill cls-pill--${tone}`}>
      <span className="cls-pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export default function StudioStatus({ link, live = false, egress = null }) {
  const linkState = describeStudioLink(link || HOST_LINK.IDLE);
  const delivery = describeDelivery({ live, egress });
  return (
    <span role="status" aria-live="polite" className="cls-pills">
      <Pill tone={linkState.tone} label={linkState.label} />
      {delivery ? <Pill tone={delivery.tone} label={delivery.label} /> : null}
    </span>
  );
}

// The live website figures (marketing/siteStats.js) inside the existing stat
// strips, with the shared count-up. The count-up ends exactly on the honest
// text ("130+") and never shows a number above the real value on the way.
import { CountUp } from "../site-kit/motion";
import { StatStrip } from "./primitives";
import { useSiteStats } from "./siteStats";

/** Items for StatStrip / DataStat: counts become a CountUp, the rating stays text. */
export function siteStatValues(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item.count !== "number") return { label: item.label, value: item.value, note: item.note || "" };
    const suffix = item.plus ? "+" : "";
    return {
      label: item.label,
      note: item.note || "",
      value: (
        <CountUp
          value={item.count}
          sessionKey={`site-stat:${item.key}`}
          format={(current) => `${Math.min(item.count, Math.floor(Number(current) || 0)).toLocaleString("en-US")}${suffix}`}
        />
      ),
    };
  });
}

/**
 * A marketing StatStrip of the live figures; renders nothing while loading,
 * when the API fails or when no figure reaches its minimum. `items` overrides
 * the fetched figures (tests, previews).
 */
export default function SiteStatStrip({ items, ...rest }) {
  const live = useSiteStats();
  const rows = Array.isArray(items) ? items : live.items;
  if (!rows.length) return null;
  return <StatStrip items={siteStatValues(rows)} {...rest} />;
}

import { INDIA_STATES, INDIA_VIEWBOX } from "../data/indiaMap";

// FIR activity markers placed on real state locations (viewBox: 0 0 612 696).
// status: "done" (completed) | "progress" | "planned"
const MARKERS = [
  { x: 176, y: 72, r: 3.4, status: "progress" }, // Srinagar, J&K
  { x: 155, y: 158, r: 3.2, status: "done" }, // Punjab
  { x: 187, y: 206, r: 4.2, status: "done" }, // Delhi
  { x: 171, y: 197, r: 3, status: "planned" }, // Haryana
  { x: 228, y: 176, r: 2.8, status: "planned" }, // Uttarakhand
  { x: 160, y: 255, r: 3.6, status: "progress" }, // Jaipur, Rajasthan
  { x: 265, y: 258, r: 4.4, status: "done" }, // Lucknow, UP
  { x: 365, y: 278, r: 3.4, status: "done" }, // Patna, Bihar
  { x: 423, y: 329, r: 4.2, status: "done" }, // Kolkata, WB
  { x: 508, y: 270, r: 3.2, status: "progress" }, // Guwahati, Assam
  { x: 558, y: 226, r: 2.6, status: "planned" }, // Arunachal
  { x: 213, y: 314, r: 4, status: "progress" }, // Bhopal, MP
  { x: 65, y: 350, r: 3.4, status: "done" }, // Ahmedabad, Gujarat
  { x: 168, y: 427, r: 4.4, status: "done" }, // Mumbai, Maharashtra
  { x: 288, y: 382, r: 3, status: "planned" }, // Raipur, Chhattisgarh
  { x: 332, y: 405, r: 3.4, status: "progress" }, // Bhubaneswar, Odisha
  { x: 371, y: 327, r: 2.8, status: "planned" }, // Ranchi, Jharkhand
  { x: 226, y: 458, r: 4.2, status: "done" }, // Hyderabad, Telangana
  { x: 258, y: 528, r: 3.2, status: "progress" }, // Amaravati, AP
  { x: 175, y: 517, r: 3.8, status: "done" }, // Bengaluru, Karnataka
  { x: 210, y: 600, r: 3.8, status: "done" }, // Chennai, Tamil Nadu
  { x: 172, y: 611, r: 3, status: "progress" }, // Kochi, Kerala
];

function markerFill(status) {
  if (status === "done") return "#ffffff";
  if (status === "progress") return "#cfcfcf";
  return "#8a8a8a";
}

export default function IndiaMap({ className = "" }) {
  return (
    <svg
      viewBox={INDIA_VIEWBOX}
      className={className}
      role="img"
      aria-label="Map of India showing FIR activity across states"
    >
      <defs>
        <radialGradient id="india-sheen" cx="42%" cy="34%" r="75%">
          <stop offset="0%" stopColor="#2a2a2a" />
          <stop offset="55%" stopColor="#141414" />
          <stop offset="100%" stopColor="#0a0a0a" />
        </radialGradient>
        <filter id="india-glow" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="3.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* States */}
      <g>
        {INDIA_STATES.map((s) => (
          <path
            key={s.id}
            d={s.d}
            fill="url(#india-sheen)"
            stroke="rgba(255,255,255,0.34)"
            strokeWidth="0.7"
            strokeLinejoin="round"
          />
        ))}
      </g>

      {/* Activity markers */}
      <g filter="url(#india-glow)">
        {MARKERS.map((m, i) => (
          <g key={i} className="nd-dot-glow" style={{ transformOrigin: `${m.x}px ${m.y}px`, animationDelay: `${(i % 7) * 0.32}s` }}>
            <circle cx={m.x} cy={m.y} r={m.r * 2.2} fill={markerFill(m.status)} opacity="0.14" />
            <circle cx={m.x} cy={m.y} r={m.r} fill={markerFill(m.status)} />
          </g>
        ))}
      </g>
    </svg>
  );
}

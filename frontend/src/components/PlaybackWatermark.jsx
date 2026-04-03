import { useEffect, useMemo, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const WATERMARK_POSITIONS = [
  { top: "14%", left: "14%", rotate: -8 },
  { top: "14%", left: "50%", rotate: -4 },
  { top: "14%", left: "82%", rotate: 7 },
  { top: "42%", left: "20%", rotate: -6 },
  { top: "42%", left: "78%", rotate: 5 },
  { top: "64%", left: "50%", rotate: -3 },
];

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-IN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function pickNextPositionIndex(previousIndex) {
  if (WATERMARK_POSITIONS.length <= 1) {
    return 0;
  }

  let nextIndex = previousIndex;
  while (nextIndex === previousIndex) {
    nextIndex = Math.floor(Math.random() * WATERMARK_POSITIONS.length);
  }
  return nextIndex;
}

function buildWatermarkIdentity(user) {
  const fullName = String(user?.full_name || "").trim();
  const email = String(user?.email || "").trim();
  const userId = Number(user?.id || 0) || null;
  const nameLabel = fullName || email.split("@")[0] || "Authenticated User";

  return {
    nameLabel,
    detailParts: [email || null, userId ? `ID ${userId}` : null].filter(Boolean),
  };
}

function formatTimestamp(date) {
  return TIMESTAMP_FORMATTER.format(date).replace(",", "");
}

export default function PlaybackWatermark({ enabled = true, className = "" }) {
  const { user, isAuthenticated } = useAuth();
  const identity = useMemo(() => buildWatermarkIdentity(user), [user]);
  const [timestamp, setTimestamp] = useState(() => formatTimestamp(new Date()));
  const [positionIndex, setPositionIndex] = useState(() =>
    Math.floor(Math.random() * WATERMARK_POSITIONS.length)
  );

  useEffect(() => {
    if (!enabled || !isAuthenticated) {
      return undefined;
    }

    const timeInterval = window.setInterval(() => {
      setTimestamp(formatTimestamp(new Date()));
    }, 1000);
    const positionInterval = window.setInterval(() => {
      setPositionIndex((previousIndex) => pickNextPositionIndex(previousIndex));
    }, 12000);

    return () => {
      window.clearInterval(timeInterval);
      window.clearInterval(positionInterval);
    };
  }, [enabled, isAuthenticated]);

  if (!enabled || !isAuthenticated) {
    return null;
  }

  const position = WATERMARK_POSITIONS[positionIndex] || WATERMARK_POSITIONS[0];

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 z-10 overflow-hidden select-none ${className}`.trim()}
    >
      <div
        className="absolute transition-[top,left,transform,opacity] duration-[1400ms] ease-out"
        style={{
          top: position.top,
          left: position.left,
          transform: `translate(-50%, -50%) rotate(${position.rotate}deg)`,
        }}
      >
        <div className="max-w-[62vw] rounded-xl border border-white/5 bg-black/8 px-2 py-1 text-white/50 opacity-35 shadow-[0_6px_16px_rgba(0,0,0,0.08)] sm:max-w-[68vw] sm:px-2.5 sm:py-1.5 sm:opacity-40">
          <div className="font-mono text-[8px] font-semibold uppercase tracking-[0.18em] text-white/34 sm:text-[9px] sm:tracking-[0.2em]">
            {identity.nameLabel}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[7px] text-white/24 sm:text-[8px]">
            {identity.detailParts.map((part) => (
              <span key={part}>{part}</span>
            ))}
            <span>{timestamp}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

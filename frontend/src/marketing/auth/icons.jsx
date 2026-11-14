// Monochrome stroke icons for the auth surfaces (currentColor, 1.5 px,
// aria-hidden). Status is always icon + word + luminance, never hue.

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": "true",
  focusable: "false",
};

export function ChevronRight({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function ChevronDown({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ArrowLeft({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="M19 12H5m6-6-6 6 6 6" />
    </svg>
  );
}

export function ArrowRight({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </svg>
  );
}

export function Eye({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

export function EyeOff({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.4 16.4 0 0 1-2.6 3.4M6.4 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </svg>
  );
}

export function Info({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

/** Critical: filled octagon with an x (rendered on the inverse surface). */
export function OctagonX({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3Z" fill="currentColor" stroke="none" />
      <path d="m9.5 9.5 5 5m0-5-5 5" style={{ stroke: "var(--au-knock, #fafafa)" }} strokeWidth="1.8" />
    </svg>
  );
}

export function TriangleAlert({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4M12 17h.01" />
    </svg>
  );
}

export function CheckCircle({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
      <path d="m8 12.3 2.7 2.7L16.2 9.5" stroke="#000" strokeWidth="1.8" />
    </svg>
  );
}

export function Clock({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" strokeDasharray="2.6 2.4" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function Lock({ className }) {
  return (
    <svg {...base} className={className}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </svg>
  );
}

export function Shield({ className }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3 4.5 6v5.6c0 4.4 3.1 8.2 7.5 9.4 4.4-1.2 7.5-5 7.5-9.4V6Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </svg>
  );
}

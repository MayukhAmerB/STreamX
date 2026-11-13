// Small inline glyphs (Carbon icon shapes, 16 px grid). Inline SVG keeps the
// public bundle free of icon packages; every glyph is decorative.
const base = { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false", fill: "currentColor" };

export function ArrowRightIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M11.8 7.5 8.1 3.8l.7-.7L13.7 8l-4.9 4.9-.7-.7 3.7-3.7H2v-1z" />
    </svg>
  );
}

export function ChevronLeftIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M5 8l5-5 .7.7L6.4 8l4.3 4.3-.7.7z" />
    </svg>
  );
}

export function ChevronRightIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M11 8l-5 5-.7-.7L9.6 8 5.3 3.7 6 3z" />
    </svg>
  );
}

export function LaunchIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M13 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h5v1H3v10h10V8h1v5a1 1 0 0 1-1 1z" />
      <path d="M10 1v1h3.3L9 6.3l.7.7L14 2.7V6h1V1z" />
    </svg>
  );
}

export function CloseIcon(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 4.7 11.3 4 8 7.3 4.7 4 4 4.7 7.3 8 4 11.3l.7.7L8 8.7l3.3 3.3.7-.7L8.7 8z" />
    </svg>
  );
}

const KIND_PATHS = {
  error: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm2.7 10.5L4.5 5.3l.8-.8 6.2 6.2z",
  warning: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.6 3h1.2v5H7.4zM8 12.2a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6z",
  success: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7 11.2 4.3 8.5l.8-.8L7 9.6l3.9-3.9.8.8z",
  info: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.6 11H7.4V7h1.2zM8 5.8a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6z",
};

/** Filled status glyph for notifications (error, warning, success, info). */
export function StatusIcon({ kind = "info", ...props }) {
  return (
    <svg {...base} width={20} height={20} {...props}>
      <path d={KIND_PATHS[kind] || KIND_PATHS.info} />
    </svg>
  );
}

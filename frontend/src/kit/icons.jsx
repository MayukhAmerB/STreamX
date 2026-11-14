// Our own monochrome stroke icons (24 x 24, 1.5px, currentColor). OWNER: WS-KIT.
// No icon pack: every glyph is drawn here, decorative by default
// (aria-hidden); pass `title` to make one meaningful.
import { forwardRef } from "react";

function makeIcon(name, paths, { fill = "none" } = {}) {
  const Icon = forwardRef(function Icon({ size = 16, title, className, strokeWidth = 1.5, ...rest }, ref) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={fill}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden={title ? undefined : true}
        role={title ? "img" : undefined}
        focusable="false"
        data-icon={name}
        {...rest}
      >
        {title ? <title>{title}</title> : null}
        {paths}
      </svg>
    );
  });
  Icon.displayName = `Icon(${name})`;
  return Icon;
}

export const ArrowRight = makeIcon("arrow-right", <path d="M5 12h14M13 6l6 6-6 6" />);
export const ArrowLeft = makeIcon("arrow-left", <path d="M19 12H5M11 18l-6-6 6-6" />);
export const ArrowUpRight = makeIcon("arrow-up-right", <path d="M7 17 17 7M8 7h9v9" />);
export const ChevronRight = makeIcon("chevron-right", <path d="m9 6 6 6-6 6" />);
export const ChevronDown = makeIcon("chevron-down", <path d="m6 9 6 6 6-6" />);
export const Check = makeIcon("check", <path d="m5 12.5 4.2 4.2L19 7" />);
export const Close = makeIcon("close", <path d="M6 6l12 12M18 6 6 18" />);
export const Menu = makeIcon("menu", <path d="M4 7h16M4 12h16M4 17h16" />);
export const Search = makeIcon("search", (
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </>
));
export const Lock = makeIcon("lock", (
  <>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </>
));
export const Clock = makeIcon("clock", (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>
));
/** "Planned": a dashed clock (status without hue). */
export const ClockDashed = makeIcon("clock-dashed", (
  <>
    <circle cx="12" cy="12" r="8.5" strokeDasharray="3 2.6" />
    <path d="M12 7.5V12l3 2" />
  </>
));
export const Info = makeIcon("info", (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </>
));
export const Alert = makeIcon("alert", (
  <>
    <path d="M12 4 21 19.5H3L12 4Z" />
    <path d="M12 10v4.5M12 17h.01" />
  </>
));
export const CheckCircle = makeIcon("check-circle", (
  <>
    <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
    <path d="m8 12.3 2.7 2.7L16.2 9.5" stroke="var(--icon-knockout, #000)" strokeWidth="1.8" />
  </>
));
export const HalfCircle = makeIcon("half-circle", (
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
  </>
));
export const OctagonX = makeIcon("octagon-x", (
  <>
    <path d="M8.3 3.5h7.4l4.8 4.8v7.4l-4.8 4.8H8.3l-4.8-4.8V8.3Z" fill="currentColor" stroke="none" />
    <path d="m9.5 9.5 5 5M14.5 9.5l-5 5" stroke="var(--icon-knockout, #fff)" strokeWidth="1.8" />
  </>
));
export const Circle = makeIcon("circle", <circle cx="12" cy="12" r="8.5" />);
export const Dot = makeIcon("dot", <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />);
export const Eye = makeIcon("eye", (
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </>
));
export const EyeOff = makeIcon("eye-off", (
  <>
    <path d="M10.6 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.6 6.6C3.9 8.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 4.4-1.1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </>
));
export const Terminal = makeIcon("terminal", (
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="m7 10 3 2.5L7 15M12.5 15H17" />
  </>
));
export const Play = makeIcon("play", <path d="M8 5.5v13l10.5-6.5Z" />);
export const Plus = makeIcon("plus", <path d="M12 5v14M5 12h14" />);
export const Minus = makeIcon("minus", <path d="M5 12h14" />);
export const External = ArrowUpRight;
export const Spark = makeIcon("spark", <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />);
export const Command = makeIcon("command", <path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H9V6.5Zm0 0V17.5m0-8.5h6m-6 6h6m0-8.5A2.5 2.5 0 1 1 17.5 9H15V6.5Zm0 0v11m0 0A2.5 2.5 0 1 0 17.5 15H15v2.5Zm-6 0A2.5 2.5 0 1 1 6.5 15H9v2.5Z" />);

// Building blocks shared by Console Home (Learn) and Teach > Today. OWNER: WS-C.
import { Calendar, Education, Flag, PlayFilledAlt, Report, Video, VideoChat } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isExternalHref } from "./homeModel";

export const KIND_ICONS = Object.freeze({
  video: Video,
  flag: Flag,
  report: Report,
  play: PlayFilledAlt,
  calendar: Calendar,
  education: Education,
  recording: VideoChat,
});

/** Router link for app paths, new-tab anchor for absolute URLs (labs). */
export function SmartLink({ href, children, className, ...rest }) {
  if (isExternalHref(href)) {
    return (
      <a href={href} className={className} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
        <span className="cds--visually-hidden"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link to={href || "/console"} className={className} {...rest}>
      {children}
    </Link>
  );
}

/** "— Saturday, 14 November": the one eyebrow pattern (32×2 rule + label). */
export function Eyebrow({ children, id, as: Tag = "p" }) {
  return (
    <Tag className="ch-eyebrow" id={id}>
      <span className="ch-eyebrow__rule" aria-hidden="true" />
      <span>{children}</span>
    </Tag>
  );
}

/** 16:9 course art with a fixed footprint (no layout shift), fades in once decoded. */
export function Artwork({ src, className = "", icon: Icon = Education, eager = false }) {
  const [state, setState] = useState(src ? "loading" : "empty");
  useEffect(() => {
    setState(src ? "loading" : "empty");
  }, [src]);
  return (
    <div className={`ch-art ${className}`} data-state={state} aria-hidden="true">
      {src && state !== "error" ? (
        <img src={src} alt="" loading={eager ? "eager" : "lazy"} decoding="async" onLoad={() => setState("ready")} onError={() => setState("error")} />
      ) : (
        <span className="ch-art__placeholder">
          <Icon size={32} />
        </span>
      )}
    </div>
  );
}

/** Placeholder bars in the exact footprint of the final content (M3). */
export function SkeletonBar({ variant }) {
  return <span className={`ch-skel ch-skel--${variant}`} />;
}

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { scrollToSection } from "../../features/youtube/watchAnchor";

/**
 * Deep links to landing anchors (/#about, /#contact, /#watch). The browser's
 * own anchor jump fires before the lazily loaded page has rendered, so it
 * lands nowhere. Scroll once per hash, after `ready` (the data bands above
 * have settled, so the target no longer moves) and once the target exists.
 */
export function useHashScroll(ids, ready = true) {
  const { hash } = useLocation();
  const scrolledFor = useRef("");
  const key = ids.join(",");

  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id || !key.split(",").includes(id) || !ready || scrolledFor.current === hash) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (scrollToSection(id)) scrolledFor.current = hash;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hash, key, ready]);

  useEffect(() => {
    if (!hash) scrolledFor.current = "";
  }, [hash]);
}

export default useHashScroll;

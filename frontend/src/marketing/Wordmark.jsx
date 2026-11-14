// Giant footer wordmark (PHILOSOPHY T7): Geist 600 + one Handlee half, sized to
// fill the frame exactly, bottom cropped by the page end. Decorative
// (aria-hidden): the brand name is in the footer text. The size is fitted
// after fonts load (no CLS: it sits below every fold) and starts from a CSS
// clamp so it already fits closely before the script runs.
import { useEffect, useRef } from "react";

import { siteBrand } from "../config/siteBrand";

export function wordmarkParts(brandId = siteBrand.id) {
  return brandId === "owlcognito" ? ["Owl", "Cognito"] : ["Al", "Syed"];
}

export default function Wordmark({ brandId = siteBrand.id }) {
  const ref = useRef(null);
  const [first, second] = wordmarkParts(brandId);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof window === "undefined" || typeof window.ResizeObserver !== "function") return undefined;
    let frame = 0;
    const fit = () => {
      const text = node.firstElementChild;
      const width = node.clientWidth;
      if (!text || !width) return;
      text.style.fontSize = "100px";
      const natural = text.scrollWidth;
      if (natural > 0) text.style.fontSize = `${Math.floor((width / natural) * 100 * 0.995)}px`;
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fit);
    };
    const observer = new window.ResizeObserver(schedule);
    observer.observe(node);
    document.fonts?.ready?.then(schedule).catch(() => {});
    schedule();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={ref} className="hp-wordmark" aria-hidden="true">
      <span className="hp-wordmark__text">
        {first}
        <span className="hp-wordmark__hand">{second}</span>
      </span>
    </div>
  );
}

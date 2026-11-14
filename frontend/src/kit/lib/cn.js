// cn(): clsx + tailwind-merge (shadcn pattern). OWNER: WS-KIT.
// tailwind-merge v2 understands Tailwind 3.4; it is taught our custom
// font-size and radius keys so `text-eyebrow` and `text-white` do not
// cancel each other out.
import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["eyebrow", "kicker", "label", "display-sm", "display", "display-xl"] }],
      rounded: [{ rounded: ["plan", "plan-outer"] }],
      shadow: [{ shadow: ["dot-active", "plan", "plan-hover", "tactile", "tactile-pressed", "window", "glow"] }],
      tracking: [{ tracking: ["eyebrow", "chapter", "kicker", "faq", "badge", "title-tight", "h2-tight"] }],
    },
  },
});

/** Joins class names (strings, arrays, objects) and resolves Tailwind conflicts (last wins). */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

/** True for http(s) links that leave the site. */
export function isExternalHref(href) {
  return typeof href === "string" && /^https?:\/\//i.test(href) && !(typeof window !== "undefined" && href.startsWith(window.location.origin));
}

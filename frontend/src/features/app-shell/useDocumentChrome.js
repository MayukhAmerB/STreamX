import { useEffect } from "react";
import { THEME_BACKGROUNDS } from "./theme";

function setMetaContent(name, content) {
  const meta = document.querySelector(`meta[name="${name}"]`);
  if (!meta) return () => {};
  const previous = meta.getAttribute("content");
  meta.setAttribute("content", content);
  return () => {
    if (previous === null) meta.removeAttribute("content");
    else meta.setAttribute("content", previous);
  };
}

/**
 * While the app shell is mounted: match the browser/OS chrome colour to the
 * Carbon theme and let the layout extend under notches (safe-area insets).
 * Both are restored when the user leaves the shell, so public pages keep the
 * exact meta values from index.html.
 */
export function useDocumentChrome(carbonTheme) {
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    return setMetaContent("theme-color", THEME_BACKGROUNDS[carbonTheme] || THEME_BACKGROUNDS.white);
  }, [carbonTheme]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const meta = document.querySelector('meta[name="viewport"]');
    const current = meta?.getAttribute("content") || "";
    if (!meta || current.includes("viewport-fit")) return undefined;
    return setMetaContent("viewport", `${current}, viewport-fit=cover`);
  }, []);
}

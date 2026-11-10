import { useEffect } from "react";
import { SHELL_THEME_COLOR } from "./theme";

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
 * black Console, let the layout extend under notches (safe-area
 * insets) and name the tab "<page> · Console". All are restored when
 * the user leaves the shell, so public pages keep the exact values from
 * index.html / main.jsx.
 */
export function useDocumentChrome(documentTitle = "") {
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    return setMetaContent("theme-color", SHELL_THEME_COLOR);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || !documentTitle) return undefined;
    const previous = document.title;
    document.title = documentTitle;
    return () => {
      document.title = previous;
    };
  }, [documentTitle]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const meta = document.querySelector('meta[name="viewport"]');
    const current = meta?.getAttribute("content") || "";
    if (!meta || current.includes("viewport-fit")) return undefined;
    return setMetaContent("viewport", `${current}, viewport-fit=cover`);
  }, []);
}

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import { siteBrand } from "./config/siteBrand";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/site-theme.css";
import "./index.css";

document.documentElement.dataset.siteBrand = siteBrand.id;
if (!document.title) document.title = siteBrand.documentTitle;

// Developer credit: Ibrahim Mohsin Mayukh Bhatt
const routedApp = (
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>{routedApp}</React.StrictMode>
);

const bootLoader = document.getElementById("boot-loader");
if (bootLoader && document.body) {
  // No-flash hand-over (plan §7.1: the old 300 ms hold + 760 ms fade are gone).
  // #root stays transparent until React has painted (two frames), then the
  // loader and #root cross-fade in BOOT_FADE_MS (index.html); no extra hold.
  const BOOT_FADE_MS = 150;

  const completeTransition = () => {
    if (bootLoader.isConnected) {
      bootLoader.remove();
    }
  };

  const beginTransition = () => {
    document.body.classList.add("app-ready");
    document.body.classList.remove("preload-active");
    bootLoader.addEventListener(
      "transitionend",
      (event) => {
        if (event.propertyName === "opacity") {
          completeTransition();
        }
      },
      { once: true }
    );
    // Fallback in case transitionend does not fire (reduced motion, hidden tab).
    window.setTimeout(completeTransition, BOOT_FADE_MS + 100);
  };

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(beginTransition);
  });
}

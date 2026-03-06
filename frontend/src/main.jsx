import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import App from "./App";
import { AuthProvider } from "./context/AuthContext";
import "./index.css";

// Developer credit: Ibrahim Mohsin Mayukh Bhatt
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={googleClientId}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </GoogleOAuthProvider>
  </React.StrictMode>
);

const bootLoader = document.getElementById("boot-loader");
if (bootLoader && document.body) {
  const bootstrapStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const MIN_BOOT_LOADER_MS = 900;

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
    // Fallback in case transitionend does not fire.
    window.setTimeout(completeTransition, 1100);
  };

  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const remaining = Math.max(0, MIN_BOOT_LOADER_MS - (now - bootstrapStartedAt));

  window.setTimeout(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(beginTransition);
    });
  }, remaining);
}

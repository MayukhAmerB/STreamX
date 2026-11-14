// `vite preview` config for the E2E stack: serves the production build and
// proxies the backend paths to the nginx-like gateway (which forwards to
// Django and applies the /media/ allowlist + X-Accel-Redirect).
const gateway = process.env.E2E_GATEWAY_URL || "http://127.0.0.1:18080";
const backend = { target: gateway, changeOrigin: false, ws: false };

export default {
  appType: "spa",
  preview: {
    // Vite answers CORS preflights itself by default (no credentials); let
    // Django's corsheaders answer them, as nginx does in production.
    cors: false,
    proxy: {
      "/api": backend,
      "/media": backend,
      "/admin/": backend,
      "/static/": backend,
      "/_protected_media": backend,
    },
  },
};

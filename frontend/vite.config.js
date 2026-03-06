import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("livekit-client")) return "vendor-livekit";
          if (id.includes("hls.js")) return "vendor-hls";
          if (id.includes("react-router-dom")) return "vendor-router";
          if (id.includes("react") || id.includes("react-dom")) return "vendor-react";
          if (id.includes("axios")) return "vendor-http";
          return "vendor-misc";
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
      "/media": {
        target: "http://127.0.0.1:8000",
        changeOrigin: false,
      },
    },
  },
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Default <head> metadata per brand: what link previews (WhatsApp, X, LinkedIn)
// and crawlers see before JavaScript runs. Routes refine it at runtime
// (src/config/pageMeta.js). Keep in step with src/config/siteBrand.js.
const BRAND_META = {
  alsyed: {
    title: "Al syed Initiative | Live OSINT Training, Labs & CTF",
    siteName: "Al syed Initiative",
    description:
      "Live OSINT classes every Fri, Sat and Sun, weekly marked reports, real investigation labs and certificates anyone can verify. Start free; Pentesting coming soon.",
    origin: "https://alsyedinitiative.com",
    image: "/og-image.jpg",
    imageAlt: "Al Syed Initiative: professional cybersecurity training",
    sitemap: [
      "/",
      "/courses",
      "/watch",
      "/about",
      "/contact",
      "/faqs",
      "/national-desk",
      "/as-accounts",
      "/hall-of-fame",
      "/join-alsyed",
      "/terms",
    ],
  },
  owlcognito: {
    title: "OwlCognito | Intelligence Training",
    siteName: "OwlCognito",
    description:
      "A private intelligence learning platform with structured courses, live instruction and practical research workflows.",
    origin: "",
    image: "",
    imageAlt: "",
    sitemap: null,
  },
};

const escapeAttr = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function siteMetaPlugin(env) {
  const brand = BRAND_META[String(env.VITE_SITE_BRAND || "alsyed").trim().toLowerCase()] || BRAND_META.alsyed;
  const origin = String(env.VITE_SITE_ORIGIN || brand.origin || "").replace(/\/+$/, "");
  const tags = [
    `<title>${escapeAttr(brand.title)}</title>`,
    `<meta name="description" content="${escapeAttr(brand.description)}" />`,
    origin ? `<link rel="canonical" href="${escapeAttr(origin)}/" />` : "",
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escapeAttr(brand.siteName)}" />`,
    `<meta property="og:title" content="${escapeAttr(brand.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(brand.description)}" />`,
    `<meta property="og:locale" content="en_IN" />`,
    origin ? `<meta property="og:url" content="${escapeAttr(origin)}/" />` : "",
    origin && brand.image ? `<meta property="og:image" content="${escapeAttr(origin + brand.image)}" />` : "",
    origin && brand.image ? `<meta property="og:image:width" content="1200" />` : "",
    origin && brand.image ? `<meta property="og:image:height" content="630" />` : "",
    origin && brand.image ? `<meta property="og:image:alt" content="${escapeAttr(brand.imageAlt)}" />` : "",
    `<meta name="twitter:card" content="${origin && brand.image ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${escapeAttr(brand.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(brand.description)}" />`,
    origin && brand.image ? `<meta name="twitter:image" content="${escapeAttr(origin + brand.image)}" />` : "",
  ].filter(Boolean);
  return {
    name: "site-meta",
    transformIndexHtml(html) {
      return html.replace("<!--site-meta-->", tags.join("\n    "));
    },
    // sitemap.xml of the public pages + its line in robots.txt (brands with a known origin only).
    generateBundle() {
      if (!origin || !brand.sitemap) return;
      const urls = brand.sitemap
        .map((path) => `  <url><loc>${escapeAttr(origin + path)}</loc></url>`)
        .join("\n");
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
    },
    writeBundle(options) {
      if (!origin || !brand.sitemap) return;
      const robots = path.join(options.dir || "dist", "robots.txt");
      if (!fs.existsSync(robots)) return;
      const text = fs.readFileSync(robots, "utf8");
      if (!/^Sitemap:/im.test(text)) {
        fs.writeFileSync(robots, `${text.replace(/\s*$/, "\n")}\nSitemap: ${origin}/sitemap.xml\n`);
      }
    },
  };
}

/**
 * Landing LCP (plan §7.3 budgets): the landing route is a lazy chunk, which
 * would add a request after the main bundle runs. On "/" only, an inline
 * script asks the browser to fetch that chunk (and its CSS) in parallel with
 * the entry bundle. Other routes are unaffected.
 */
function landingPreloadPlugin() {
  return {
    name: "landing-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx?.bundle;
        if (!bundle) return html;
        const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
        const entry = chunks.find((chunk) => chunk.isEntry);
        const isLandingModule = (id) => String(id || "").replace(/\\/g, "/").endsWith("/src/pages/LandingPage.jsx");
        const landing = chunks.find(
          (chunk) =>
            isLandingModule(chunk.facadeModuleId) ||
            (chunk.isDynamicEntry && (chunk.moduleIds || Object.keys(chunk.modules || {})).some(isLandingModule))
        );
        if (!entry || !landing) return html;
        const loaded = new Set([entry.fileName, ...(entry.imports || [])]);
        const scripts = [landing.fileName, ...(landing.imports || [])].filter((file) => !loaded.has(file));
        const loadedCss = new Set(entry.viteMetadata?.importedCss || []);
        const styles = [
          ...new Set(
            scripts.flatMap((file) => [...(bundle[file]?.viteMetadata?.importedCss || [])]).filter((file) => !loadedCss.has(file))
          ),
        ];
        const toUrl = (file) => `/${file}`;
        // HackPath hero (WS-KIT): the Qur'an 20:114 calligraphy is the landing LCP image. Preload the
        // wide SVG above 640 px and the stacked one at or below, with high priority, on "/" only.
        const heroAsset = (needle) =>
          Object.values(bundle).find((item) => item.type === "asset" && item.fileName.includes(needle) && item.fileName.endsWith(".svg"));
        const heroes = [
          [heroAsset("hero-quran-20-114-stacked"), "(max-width: 640px)"],
          [Object.values(bundle).find((item) => item.type === "asset" && /hero-quran-20-114(?!-stacked)[^/]*\.svg$/.test(item.fileName)), "(min-width: 641px)"],
        ].filter(([asset]) => asset);
        const heroLinks = heroes
          .map(([asset, media]) => `var i=document.createElement("link");i.rel="preload";i.as="image";i.href=${JSON.stringify(toUrl(asset.fileName))};i.media=${JSON.stringify(media)};i.setAttribute("fetchpriority","high");h.appendChild(i);`)
          .join("");
        const script = `<script>(function(){if(location.pathname!=="/")return;var h=document.head;${heroLinks}${JSON.stringify(
          scripts.map(toUrl)
        )}.forEach(function(u){var l=document.createElement("link");l.rel="modulepreload";l.href=u;h.appendChild(l);});${JSON.stringify(
          styles.map(toUrl)
        )}.forEach(function(u){var l=document.createElement("link");l.rel="preload";l.as="style";l.href=u;h.appendChild(l);});})();</script>`;
        return html.replace("</head>", `    ${script}
  </head>`);
      },
    },
  };
}

/**
 * Dev-only component gallery (WS-KIT): `npm run dev` serves src/kit/gallery/index.html
 * at /__kit, and the insignia gallery (src/features/landing-rewards/gallery) at /__insignia. It is not a build input, so it never ships in production.
 */
function kitGalleryPlugin() {
  return {
    name: "kit-gallery",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [pathname, query = ""] = String(req.url || "").split("?");
        if (pathname === "/__kit" || pathname === "/__kit/") req.url = `/src/kit/gallery/index.html${query ? `?${query}` : ""}`;
        // Rank emblems and badge medals (WS-LEARN), same rules: dev server only.
        if (pathname === "/__insignia" || pathname === "/__insignia/") req.url = `/src/features/landing-rewards/gallery/index.html${query ? `?${query}` : ""}`;
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), siteMetaPlugin(loadEnv(mode, process.cwd(), "")), landingPreloadPlugin(), kitGalleryPlugin()],
  resolve: {
    alias: {
      "@kit": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src/kit"),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Carbon's Sass (functional app shell only) is compiled with the
        // modern Sass API; its own deprecation notices are not actionable here.
        api: "modern-compiler",
        quietDeps: true,
        silenceDeprecations: ["if-function"],
      },
    },
  },
  build: {
    sourcemap: false,
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
}));

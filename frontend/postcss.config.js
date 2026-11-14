import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
// WS-A (UI overhaul §2.4): drops Carbon output the Console can never use
// (only touches src/features/app-shell/styles/carbon-app.scss).
import carbonPrune from "./scripts/postcss-carbon-prune.mjs";

export default {
  plugins: [tailwindcss(), autoprefixer(), carbonPrune()],
};

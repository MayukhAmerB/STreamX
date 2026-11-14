// Carbon dead-weight pruning for the Console stylesheet (UI overhaul plan
// §2.4, "Console CSS >= 25% smaller"). OWNER: WS-A.
//
// Runs only on src/features/app-shell/styles/carbon-app.scss (the Console's
// Carbon bundle) and removes output no supported browser or Console screen
// can ever use. Nothing here changes how a used rule renders.
//
//   1. `@media screen and (-ms-high-contrast: active)` blocks: IE / legacy
//      Edge only. Modern Windows high contrast is `forced-colors`, which
//      Carbon also emits and which is kept.
//   2. `.cds-app :root { ... }`: Carbon declares its layout tokens on :root;
//      nested under the shell root that selector can never match (the shell
//      re-emits the same tokens on `.cds-app`, see carbon-app.scss).
//   3. Variants the app never renders: `.cds--popover--border` (only
//      <Popover border> and <Toggletip>; IconButton tooltips use the plain
//      popover) and the AI label / "decorator" / slug variants of modal,
//      inputs, tags and skeletons (no AILabel or `decorator` prop is used).
//      Delete the matching part of UNUSED_VARIANT if a page starts using one.
//   4. Theme tokens of Carbon families the app never renders: AI ("aura",
//      AI label/skeleton), chat, syntax highlighting and fluid type.
//
// A plain PostCSS plugin object (no dependency beyond PostCSS itself, which
// Vite already ships).

const TARGET = /[\\/]features[\\/]app-shell[\\/]styles[\\/]carbon-app\.scss$/;
const DEAD_MEDIA = /-ms-high-contrast/;
const DEAD_SELECTOR = /^\s*\.cds-app\s+:root\s*$/;
const UNUSED_VARIANT = /\.cds--popover--border\b|\.cds--[a-z-]*(?:--slug|--decorator|__ai\b|--ai\b|ai-label)|\.cds--slug\b/;
const UNUSED_TOKEN = /^--cds-(ai|chat|syntax|fluid)-/;

export default function carbonPrune() {
  return {
    postcssPlugin: "sc-carbon-prune",
    Once(root) {
      const file = root.source?.input?.file || "";
      if (!TARGET.test(file)) return;
      root.walkAtRules("media", (rule) => {
        if (DEAD_MEDIA.test(rule.params)) rule.remove();
      });
      root.walkRules((rule) => {
        if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
        const selectors = rule.selectors || [];
        if (selectors.length && selectors.every((selector) => DEAD_SELECTOR.test(selector))) {
          rule.remove();
          return;
        }
        if (selectors.length && selectors.every((selector) => UNUSED_VARIANT.test(selector))) {
          rule.remove();
          return;
        }
        const kept = selectors.filter((selector) => !UNUSED_VARIANT.test(selector));
        if (kept.length && kept.length !== selectors.length) rule.selectors = kept;
      });
      root.walkDecls((decl) => {
        if (UNUSED_TOKEN.test(decl.prop)) decl.remove();
      });
      // Rules and media blocks left empty by the passes above.
      root.walkRules((rule) => {
        if (!rule.nodes?.length) rule.remove();
      });
      root.walkAtRules("media", (rule) => {
        if (!rule.nodes?.length) rule.remove();
      });
    },
  };
}
carbonPrune.postcss = true;

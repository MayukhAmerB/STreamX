// Console Home (`/console`). The old hub (stat chips, countdown, shortcut
// tiles) was replaced by the "Next up" Home of the UI overhaul (WS-C,
// plan §3.4); this module keeps the import path routes and tests use.
export { default } from "../features/console-home/HomePage";
export { default as UsersCornerView } from "../features/console-home/HomeView";

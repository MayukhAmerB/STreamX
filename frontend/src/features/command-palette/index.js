// Ctrl/Cmd+K command palette (UI overhaul plan §4.5, Appendix A.5).
// OWNER: WS-G (stub created by WS-0 with the final exports).
//
//   openCommandPalette({ initialQuery })   from anywhere (header field, buttons)
//   <CommandPalette />                     mounted once by the shell (WS-B)
export { default as CommandPalette } from "./CommandPalette";
export { COMMAND_PALETTE_OPEN_EVENT, openCommandPalette } from "./events";

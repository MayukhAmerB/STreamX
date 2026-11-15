// Insignia metals and energy (rank emblems + badge medals). OWNER: WS-LEARN.
//
// Owner request (Nov 2026): "security military" insignia that people dream of
// earning. Metals climb gunmetal -> steel -> silver -> platinum -> obsidian;
// the only hues are a cyan/emerald energy core. NO gold, amber or yellow.
// Every non-grey colour of the insignia lives in this one file, so the palette
// baseline (scripts/palette-baseline.json) carries one short, reviewed list.

export const HUE = Object.freeze({
  obsidian: "#0a0d12",
  gunmetal: "#3b434b",
  steel: "#7d8b97",
  steelLight: "#bccad4",
  platinum: "#eaf1f5",
  cyan: "#38e8ff",
  cyanDeep: "#0a86a3",
  emerald: "#3cf2ad",
  emeraldDeep: "#0b8a5f",
});

/** Linear metal gradients: `[offset, colour]` stops, drawn top-left to bottom-right. */
export const METALS = Object.freeze({
  // Rank I-II bodies, bronze-tier medals.
  gunmetal: [
    [0, "#6a6a6a"],
    [0.32, "#2b2b2b"],
    [0.58, "#474747"],
    [1, "#121212"],
  ],
  // Rims and fittings on the low ranks.
  dark: [
    [0, "#a3a3a3"],
    [0.45, HUE.gunmetal],
    [0.7, "#8a8a8a"],
    [1, "#2a2a2a"],
  ],
  // Rank III-IV, silver-tier medals.
  steel: [
    [0, HUE.steelLight],
    [0.35, HUE.gunmetal],
    [0.62, HUE.steel],
    [1, "#1f1f1f"],
  ],
  // Rank V-VI, chevrons and devices.
  silver: [
    [0, "#ffffff"],
    [0.3, HUE.steel],
    [0.55, "#e6e6e6"],
    [0.8, "#6e6e6e"],
    [1, "#d4d4d4"],
  ],
  // Rank VII-VIII, gold-tier and platinum-tier medals.
  platinum: [
    [0, "#ffffff"],
    [0.25, HUE.steelLight],
    [0.5, HUE.platinum],
    [0.72, "#8f8f8f"],
    [1, "#ffffff"],
  ],
  // Obsidian bodies (rank VIII, platinum-tier medals).
  obsidian: [
    [0, "#3a3a3a"],
    [0.4, HUE.obsidian],
    [0.75, "#1a1a1a"],
    [1, "#000000"],
  ],
});

/** Radial energy cores: `[offset, colour, opacity]`. */
export const CORES = Object.freeze({
  cyan: [
    [0, "#ffffff", 1],
    [0.3, HUE.cyan, 1],
    [0.75, HUE.cyanDeep, 1],
    [1, HUE.obsidian, 1],
  ],
  emerald: [
    [0, "#ffffff", 1],
    [0.3, HUE.emerald, 1],
    [0.75, HUE.emeraldDeep, 1],
    [1, HUE.obsidian, 1],
  ],
  // Cyan rim around an emerald heart (rank VIII, platinum medals).
  dual: [
    [0, "#ffffff", 1],
    [0.22, HUE.emerald, 1],
    [0.55, HUE.cyan, 1],
    [0.85, HUE.cyanDeep, 1],
    [1, HUE.obsidian, 1],
  ],
});

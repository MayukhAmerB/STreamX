// Dev-only: the level-up celebration overlay with fixture data
// (?section=levelup-4 | levelup-8 | levelup-static). Never in the build.
import { MemoryRouter } from "react-router-dom";

import { LevelUpOverlay } from "../../engagement-ui/LevelUpMoment";
import { celebrationView } from "../../engagement-ui/levelUpModel";

const FIXTURES = {
  4: {
    xp: 6250,
    level: { number: 4, key: "analyst", title: "Analyst", min_xp: 6000 },
    next_level: { number: 5, key: "specialist", title: "Specialist", min_xp: 9000 },
    xp_to_next_level: 2750,
    level_progress: 0.0833,
  },
  7: {
    xp: 15720,
    level: { number: 7, key: "lead_investigator", title: "Lead Investigator", min_xp: 15500 },
    next_level: { number: 8, key: "elite_operator", title: "Elite Operator", min_xp: 19000 },
    xp_to_next_level: 3280,
    level_progress: 0.063,
  },
  8: {
    xp: 19400,
    level: { number: 8, key: "elite_operator", title: "Elite Operator", min_xp: 19000 },
    next_level: null,
    xp_to_next_level: 0,
    level_progress: 1,
  },
};

export default function LevelUpGallery({ section }) {
  const match = /^levelup-(\d|static)$/.exec(section || "");
  if (!match) return null;
  const isStatic = match[1] === "static";
  const me = FIXTURES[isStatic ? 4 : Number(match[1])] || FIXTURES[4];
  return (
    <MemoryRouter>
      <div data-section={section} className="min-h-[60vh] px-8 py-10 text-[#a1a1a1]">
        Console page behind the overlay.
      </div>
      <LevelUpOverlay view={celebrationView(me)} onClose={() => {}} reducedMotion={isStatic ? true : undefined} />
    </MemoryRouter>
  );
}

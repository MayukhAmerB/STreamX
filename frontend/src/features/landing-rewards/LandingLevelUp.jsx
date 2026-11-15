// The level-up celebration on the landing page (signed-in students): the same
// once-per-promotion moment as the Console, fed by the landing rewards hook's
// cached GET /engagement/me/ (no extra request). OWNER: WS-LEARN.
import { LevelUpGate } from "../engagement-ui/LevelUpMoment";
import useLandingRewards from "./useLandingRewards";

export default function LandingLevelUp() {
  const { eligible, me } = useLandingRewards();
  if (!eligible || !me) return null;
  return <LevelUpGate data={me} />;
}

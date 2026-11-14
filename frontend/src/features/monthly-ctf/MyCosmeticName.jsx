// The signed-in viewer's display name with their Monthly CTF cosmetics
// (golden glow while the Golden Aura is active, the First Blood title chip).
// OWNER: WS-MONTHLY-CTF. Used by the Console shell's account menu.
import { CosmeticName } from "./Cosmetics";
import useMyCosmetics from "./useMyCosmetics";

export default function MyCosmeticName({ user, children, className }) {
  const cosmetics = useMyCosmetics(user);
  if (!cosmetics.aura && !cosmetics.title) return children;
  return <CosmeticName name={children} cosmetics={cosmetics} className={className} />;
}

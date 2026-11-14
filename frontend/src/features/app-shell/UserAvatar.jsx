import { CosmeticRing } from "../monthly-ctf/Cosmetics";
import useMyCosmetics from "../monthly-ctf/useMyCosmetics";

export function getUserInitial(user) {
  return String(user?.full_name || user?.email || "U").trim().charAt(0).toUpperCase() || "U";
}

/**
 * Round avatar: profile photo when available, otherwise the first initial.
 * Monthly CTF cosmetics (WS-MONTHLY-CTF): the signed-in viewer's Golden Aura
 * or podium frame wraps it while active (nothing is fetched unless the
 * `monthly_ctf` switch is on). `animated` lets the aura breathe (header only).
 */
export default function UserAvatar({ user, size = "md", src, animated = false }) {
  const imageUrl = src ?? user?.profile_image_url;
  const sizeClass = size === "md" ? "" : ` cds-app-avatar--${size}`;
  const cosmetics = useMyCosmetics(user);
  return (
    <CosmeticRing cosmetics={cosmetics} animated={animated}>
      <span className={`cds-app-avatar${sizeClass}`} aria-hidden="true">
        {imageUrl ? <img src={imageUrl} alt="" /> : getUserInitial(user)}
      </span>
    </CosmeticRing>
  );
}

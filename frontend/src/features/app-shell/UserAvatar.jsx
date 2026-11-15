export function getUserInitial(user) {
  return String(user?.full_name || user?.email || "U").trim().charAt(0).toUpperCase() || "U";
}

/** Round avatar: profile photo when available, otherwise the first initial. */
export default function UserAvatar({ user, size = "md", src }) {
  const imageUrl = src ?? user?.profile_image_url;
  const sizeClass = size === "md" ? "" : ` cds-app-avatar--${size}`;
  return (
    <span className={`cds-app-avatar${sizeClass}`} aria-hidden="true">
      {imageUrl ? <img src={imageUrl} alt="" /> : getUserInitial(user)}
    </span>
  );
}

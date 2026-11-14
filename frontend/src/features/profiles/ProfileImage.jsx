// Private profile images: fetched with the session (permission-checked by the
// API) and shown from an object URL that is revoked on unmount.
// OWNER: WS-PROFILES.
import { useEffect, useState } from "react";

import { cn } from "../../kit/lib/cn";
import { fetchProfileImageUrl } from "./profilesApi";

export function useProfileImage(src) {
  const [state, setState] = useState({ url: "", status: src ? "loading" : "none" });
  useEffect(() => {
    if (!src) {
      setState({ url: "", status: "none" });
      return undefined;
    }
    let active = true;
    let objectUrl = "";
    setState({ url: "", status: "loading" });
    fetchProfileImageUrl(src)
      .then((url) => {
        objectUrl = url;
        if (active) setState({ url, status: "ready" });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (active) setState({ url: "", status: "error" });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  return state;
}

/**
 * <ProfileImage src="/api/profiles/media/<id>/" alt="" className="aspect-[4/3]" />
 * Reserves its box (no layout shift) and shows a hairline placeholder until loaded.
 */
export default function ProfileImage({ src, alt = "", className, imgClassName, fallback = null }) {
  const { url, status } = useProfileImage(src);
  return (
    <span className={cn("relative block overflow-hidden bg-white/[.035]", className)} data-status={status}>
      {url ? (
        <img src={url} alt={alt} className={cn("size-full object-cover", imgClassName)} decoding="async" />
      ) : status === "loading" ? (
        <span aria-hidden="true" className="absolute inset-0 animate-pulse bg-white/[.04] motion-reduce:animate-none" />
      ) : (
        fallback
      )}
    </span>
  );
}

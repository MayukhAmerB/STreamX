import { useEffect, useState } from "react";
import { getLearnCourseId } from "./navConfig";

const STORAGE_KEY = "alsyed.lastCourseId";

function readStored() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/** Remembers the last course opened in the player for "Continue learning". */
export function useLastCourseId(pathname) {
  const currentCourseId = getLearnCourseId(pathname);
  const [storedCourseId, setStoredCourseId] = useState(readStored);

  useEffect(() => {
    if (!currentCourseId || currentCourseId === storedCourseId) return;
    setStoredCourseId(currentCourseId);
    try {
      window.localStorage.setItem(STORAGE_KEY, currentCourseId);
    } catch {
      // Storage unavailable: the shortcut falls back to My courses.
    }
  }, [currentCourseId, storedCourseId]);

  return currentCourseId || storedCourseId;
}

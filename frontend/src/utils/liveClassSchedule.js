export const DEFAULT_LIVE_CLASS_SCHEDULE = {
  days: ["Friday", "Saturday", "Sunday"],
  start_time: "19:00",
  end_time: "20:00",
  timezone: "Asia/Kolkata",
  timezone_label: "IST",
  label: "Friday, Saturday and Sunday, 7:00 PM to 8:00 PM IST",
  is_open: false,
  next_start: null,
  next_end: null,
};

export function isJoinableLiveSession(session) {
  if (session?.status !== "live" || session?.viewer_can_join_now !== true) return false;
  if (session?.session_type === "broadcasting") {
    return session?.stream_status === "live";
  }
  return true;
}

export function findJoinableLiveSession(sessions, liveClassId = null) {
  const normalizedLiveClassId = Number(liveClassId || 0) || null;
  return (
    (Array.isArray(sessions) ? sessions : []).find((session) => {
      if (!isJoinableLiveSession(session)) return false;
      if (!normalizedLiveClassId) return true;
      return Number(session?.linked_live_class?.id || 0) === normalizedLiveClassId;
    }) || null
  );
}

export function resolveLiveClassSchedule(sessions) {
  const schedule = (Array.isArray(sessions) ? sessions : []).find(
    (session) => session?.live_schedule
  )?.live_schedule;
  return schedule || DEFAULT_LIVE_CLASS_SCHEDULE;
}

export function formatNextLiveWindow(schedule) {
  if (!schedule?.next_start) return "Friday, Saturday and Sunday at 7:00 PM IST";
  const value = new Date(schedule.next_start);
  if (Number.isNaN(value.getTime())) return schedule.label || DEFAULT_LIVE_CLASS_SCHEDULE.label;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: schedule.timezone || "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(value);
}

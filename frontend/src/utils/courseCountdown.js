const DEFAULT_COUNTDOWN_LABEL = "Enrollment closes in";

function parseDeadline(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function getCountdownParts(deadline, now = Date.now()) {
  const deadlineTimestamp = parseDeadline(deadline);
  const nowTimestamp = Number(now);
  if (deadlineTimestamp === null || !Number.isFinite(nowTimestamp)) return null;

  const remainingMilliseconds = deadlineTimestamp - nowTimestamp;
  if (remainingMilliseconds <= 0) return null;

  let remainingSeconds = Math.ceil(remainingMilliseconds / 1000);
  const days = Math.floor(remainingSeconds / 86400);
  remainingSeconds -= days * 86400;
  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds -= hours * 3600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds - minutes * 60;

  return { days, hours, minutes, seconds };
}

export function selectActiveCourseCountdown(courses = [], now = Date.now()) {
  const nowTimestamp = Number(now);
  if (!Number.isFinite(nowTimestamp)) return null;

  const activeCountdowns = courses
    .map((course) => ({
      course,
      deadlineTimestamp: parseDeadline(course?.hero_countdown_end_at),
    }))
    .filter(({ deadlineTimestamp }) => deadlineTimestamp !== null && deadlineTimestamp > nowTimestamp)
    .sort((left, right) => left.deadlineTimestamp - right.deadlineTimestamp);

  if (!activeCountdowns.length) return null;

  const active = activeCountdowns[0];
  return {
    course: active.course,
    deadline: new Date(active.deadlineTimestamp).toISOString(),
    label: String(active.course?.hero_countdown_label || "").trim() || DEFAULT_COUNTDOWN_LABEL,
    parts: getCountdownParts(active.deadlineTimestamp, nowTimestamp),
  };
}

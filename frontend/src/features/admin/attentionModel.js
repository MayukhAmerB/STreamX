// Pure model of the "Needs attention" queues (plan §4.4). OWNER: WS-G.
// count === null → the viewer may not see that queue (hidden);
// count === 0    → collapses into one calm "All clear" line;
// count > 0      → a tile. Only the busiest tile gets the champagne button.
import { listWords, plural } from "./format";

/** Short words for the "All clear" line, in queue order. */
export const CLEAR_WORDS = Object.freeze({
  enrolment_requests: "requests",
  reports_to_grade: "grading",
  recordings_to_review: "recordings",
  uploads_failed: "uploads",
  payments_to_action: "payments",
  exams_to_publish: "exams",
  leads: "leads",
  flagged_content: "questions",
  quarantined_files: "files",
  system_issues: "system",
  plans_awaiting_price: "prices",
});

export function splitQueues(queues = []) {
  const waiting = [];
  const clear = [];
  for (const queue of queues || []) {
    if (queue == null || queue.count == null) continue;
    if (Number(queue.count) > 0) waiting.push(queue);
    else clear.push(queue);
  }
  return { waiting, clear };
}

/** The key of the queue with the most items (first in order on a tie). */
export function busiestKey(queues = []) {
  let best = null;
  for (const queue of queues) {
    if (!queue || !(Number(queue.count) > 0)) continue;
    if (!best || Number(queue.count) > Number(best.count)) best = queue;
  }
  return best ? best.key : null;
}

export function clearLine(clear = []) {
  const words = clear.map((queue) => CLEAR_WORDS[queue.key] || String(queue.label || "").toLowerCase());
  return words.length ? `All clear: ${listWords(words)}.` : "";
}

/** "3 things need you" / "1 thing needs you" / "Nothing needs you right now". */
export function summaryLine(waiting = []) {
  if (!waiting.length) return "Nothing needs you right now";
  return `${plural(waiting.length, "thing")} ${waiting.length === 1 ? "needs" : "need"} you`;
}

/** A button label that says how many: "Review 4". */
export function actionLabel(queue) {
  const label = queue?.action_label || "Open";
  return `${label} ${queue?.count ?? ""}`.trim();
}

/** Which counts changed between two polls (for the M5b "new" dot). */
export function changedKeys(previous = [], next = []) {
  const before = new Map((previous || []).map((queue) => [queue.key, queue.count]));
  return (next || [])
    .filter((queue) => before.has(queue.key) && Number(queue.count) > Number(before.get(queue.key) ?? 0))
    .map((queue) => queue.key);
}

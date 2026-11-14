// ErrorState (UI overhaul plan §2.5, §2.7, Appendix A.5). OWNER: WS-A.
// An inline error with Retry. Cached data stays on screen under it with
// "Last updated hh:mm". A 404 is not an error: use NotFoundState instead.
import PageNotification from "./PageNotification";

function message(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return error.message || "Something went wrong.";
}

function clock(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function ErrorState({ error, onRetry, lastUpdated, title = "This could not be loaded." }) {
  const updated = lastUpdated ? clock(lastUpdated) : "";
  return (
    <PageNotification
      kind="error"
      title={title}
      subtitle={[message(error), updated ? `Last updated ${updated}` : ""].filter(Boolean).join(" · ")}
      actionLabel={onRetry ? "Try again" : undefined}
      onAction={onRetry}
    />
  );
}

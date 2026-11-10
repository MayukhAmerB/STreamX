// Browser-only helper: hands an .ics file to the device (the calendar app
// on phones, a download on desktops). Returns false when unsupported.
export function downloadCalendarFile(icsText, filename = "live-classes.ics") {
  if (!icsText || typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") {
    return false;
  }
  try {
    const url = URL.createObjectURL(new Blob([icsText], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  } catch {
    return false;
  }
}

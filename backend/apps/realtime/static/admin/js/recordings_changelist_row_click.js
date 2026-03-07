(function () {
  function isInteractiveTarget(target) {
    return Boolean(
      target.closest(
        "a, button, input, select, textarea, label, video, audio, summary, [role='button']"
      )
    );
  }

  function bindRecordingRowClicks() {
    var body = document.body;
    if (!body) return;
    if (!body.classList.contains("app-realtime")) return;
    if (!body.classList.contains("model-realtimesessionrecording")) return;
    if (!body.classList.contains("change-list")) return;

    var rows = document.querySelectorAll("#result_list tbody tr");
    rows.forEach(function (row) {
      var link =
        row.querySelector("th.field-id a") ||
        row.querySelector("td.field-id a") ||
        row.querySelector("th a");
      if (!link) return;
      row.style.cursor = "pointer";
      row.addEventListener("click", function (event) {
        if (isInteractiveTarget(event.target)) return;
        window.location.href = link.href;
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindRecordingRowClicks);
  } else {
    bindRecordingRowClicks();
  }
})();

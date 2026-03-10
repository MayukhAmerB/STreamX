(function () {
  "use strict";

  function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
      return "--:--";
    }
    var seconds = Math.round(totalSeconds);
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var remainingSeconds = seconds % 60;
    if (hours > 0) {
      return (
        String(hours).padStart(2, "0") +
        ":" +
        String(minutes).padStart(2, "0") +
        ":" +
        String(remainingSeconds).padStart(2, "0")
      );
    }
    return String(minutes).padStart(2, "0") + ":" + String(remainingSeconds).padStart(2, "0");
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "0 B";
    }
    var units = ["B", "KB", "MB", "GB", "TB"];
    var size = bytes;
    var unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    var decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
    return size.toFixed(decimals) + " " + units[unitIndex];
  }

  function createProgressPanel(form) {
    var panel = document.createElement("div");
    panel.className = "upload-progress-panel";
    panel.innerHTML =
      '<div class="upload-progress-panel__header">' +
      '<strong data-role="title">Uploading video...</strong>' +
      '<span data-role="percent">0%</span>' +
      "</div>" +
      '<div class="upload-progress-panel__track">' +
      '<div class="upload-progress-panel__bar" data-role="bar"></div>' +
      "</div>" +
      '<div class="upload-progress-panel__meta">' +
      '<span data-role="details">Preparing upload...</span>' +
      '<span data-role="eta">ETA --:--</span>' +
      "</div>";

    var submitRow = form.querySelector(".submit-row");
    if (submitRow && submitRow.parentNode) {
      submitRow.parentNode.insertBefore(panel, submitRow);
    } else {
      form.insertBefore(panel, form.firstChild);
    }

    return {
      panel: panel,
      title: panel.querySelector('[data-role="title"]'),
      percent: panel.querySelector('[data-role="percent"]'),
      bar: panel.querySelector('[data-role="bar"]'),
      details: panel.querySelector('[data-role="details"]'),
      eta: panel.querySelector('[data-role="eta"]'),
    };
  }

  document.addEventListener("DOMContentLoaded", function () {
    var form = document.querySelector("form#section_form");
    if (!form) {
      return;
    }

    if (!window.XMLHttpRequest || !("upload" in new XMLHttpRequest())) {
      return;
    }

    var submitButtons = Array.prototype.slice.call(
      form.querySelectorAll('button[type="submit"], input[type="submit"]')
    );
    var progressUi = createProgressPanel(form);
    var lastClickedSubmitter = null;
    var isUploading = false;

    function hasPendingFileUpload() {
      var fileInputs = form.querySelectorAll('input[type="file"]');
      for (var i = 0; i < fileInputs.length; i += 1) {
        if (fileInputs[i].files && fileInputs[i].files.length > 0) {
          return true;
        }
      }
      return false;
    }

    function setSubmitButtonsDisabled(disabled) {
      submitButtons.forEach(function (button) {
        button.disabled = disabled;
      });
    }

    function setProgressState(visible, isError) {
      if (visible) {
        progressUi.panel.classList.add("is-visible");
      } else {
        progressUi.panel.classList.remove("is-visible");
      }

      if (isError) {
        progressUi.panel.classList.add("is-error");
      } else {
        progressUi.panel.classList.remove("is-error");
      }
    }

    function setProgress(loaded, total, startedAt) {
      if (!total || total <= 0) {
        progressUi.title.textContent = "Uploading video...";
        progressUi.percent.textContent = "--";
        progressUi.details.textContent = "Uploading...";
        progressUi.eta.textContent = "ETA --:--";
        return;
      }

      var ratio = Math.min(1, Math.max(0, loaded / total));
      var percentValue = ratio * 100;
      var elapsedSeconds = (Date.now() - startedAt) / 1000;
      var bytesPerSecond = elapsedSeconds > 0 ? loaded / elapsedSeconds : 0;
      var remainingSeconds = bytesPerSecond > 0 ? (total - loaded) / bytesPerSecond : NaN;

      progressUi.title.textContent = percentValue >= 100 ? "Upload complete. Finalizing..." : "Uploading video...";
      progressUi.percent.textContent = percentValue.toFixed(1) + "%";
      progressUi.bar.style.width = percentValue.toFixed(1) + "%";
      progressUi.details.textContent = formatBytes(loaded) + " / " + formatBytes(total);
      progressUi.eta.textContent = "ETA " + formatDuration(remainingSeconds);
    }

    function failUpload(message) {
      isUploading = false;
      setSubmitButtonsDisabled(false);
      setProgressState(true, true);
      progressUi.title.textContent = "Upload failed";
      progressUi.percent.textContent = "--";
      progressUi.details.textContent = message || "Unexpected error while uploading.";
      progressUi.eta.textContent = "Please retry";
      progressUi.bar.style.width = "0%";
    }

    submitButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        lastClickedSubmitter = button;
      });
    });

    form.addEventListener("submit", function (event) {
      if (!hasPendingFileUpload()) {
        return;
      }
      if (isUploading) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      isUploading = true;

      setProgressState(true, false);
      progressUi.title.textContent = "Preparing upload...";
      progressUi.percent.textContent = "0%";
      progressUi.details.textContent = "Preparing upload...";
      progressUi.eta.textContent = "ETA --:--";
      progressUi.bar.style.width = "0%";

      var submitter = event.submitter || lastClickedSubmitter;
      var formData = new FormData(form);
      if (submitter && submitter.name && !formData.has(submitter.name)) {
        formData.append(submitter.name, submitter.value || "1");
      }

      setSubmitButtonsDisabled(true);

      var request = new XMLHttpRequest();
      var method = (form.method || "POST").toUpperCase();
      var action = form.action || window.location.href;
      var startedAt = Date.now();

      request.open(method, action, true);

      request.upload.addEventListener("progress", function (progressEvent) {
        if (progressEvent.lengthComputable) {
          setProgress(progressEvent.loaded, progressEvent.total, startedAt);
        } else {
          progressUi.title.textContent = "Uploading video...";
          progressUi.percent.textContent = "--";
          progressUi.details.textContent = "Upload in progress...";
          progressUi.eta.textContent = "ETA --:--";
        }
      });

      request.addEventListener("load", function () {
        if (request.status >= 200 && request.status < 400) {
          var destination = request.responseURL || window.location.href;
          window.location.assign(destination);
          return;
        }

        if (request.responseText && request.responseText.indexOf("<html") !== -1) {
          document.open();
          document.write(request.responseText);
          document.close();
          return;
        }

        failUpload("Upload failed with status " + request.status + ".");
      });

      request.addEventListener("error", function () {
        failUpload("Network error during upload.");
      });

      request.addEventListener("abort", function () {
        failUpload("Upload was cancelled.");
      });

      request.send(formData);
    });
  });
})();

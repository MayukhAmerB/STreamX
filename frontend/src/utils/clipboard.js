export async function copyTextToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) {
    throw new Error("Nothing available to copy.");
  }

  if (navigator?.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back below. Some browsers lose the clipboard permission after an awaited API call.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Browser blocked clipboard access.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

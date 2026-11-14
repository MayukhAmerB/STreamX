// Copy to the clipboard and say so in a toast. OWNER: WS-D1.
import { useCallback } from "react";
import { apiMessage } from "../../utils/api";
import { copyTextToClipboard } from "../../utils/clipboard";
import { useToast } from "../app-shell/ui";

export default function useCopyToast() {
  const { showToast } = useToast();
  return useCallback(
    async (value, successMessage, emptyMessage, errorMessage = "Unable to copy.") => {
      if (!value) {
        showToast({ kind: "error", title: emptyMessage || "Nothing to copy yet." });
        return false;
      }
      try {
        await copyTextToClipboard(value);
        showToast({ kind: "success", title: successMessage });
        return true;
      } catch (err) {
        showToast({ kind: "error", title: errorMessage, subtitle: apiMessage(err, "") });
        return false;
      }
    },
    [showToast]
  );
}

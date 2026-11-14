// The Classes page's destructive row actions. Each one asks first through a
// ConfirmDialog that names the class; nothing is sent when the host says no.
// Plain functions (no React) so the rule is unit tested. OWNER: WS-D1.
import { apiData, apiMessage } from "../../utils/api";
import { confirmCopy } from "./classesModel";

export function createClassActions({ confirm, api, sessions, controller, showToast, setBusyId = () => {} }) {
  const run = async (session, kind, work) => {
    if (!(await confirm(confirmCopy(kind, session)))) return false;
    setBusyId(session.id);
    try {
      await work();
      return true;
    } finally {
      setBusyId(null);
    }
  };

  return {
    async stop(session) {
      return run(session, "stop", async () => {
        try {
          const updated = apiData(await api.stopRealtimeStream(session.id), null);
          if (updated) sessions.replaceRow(updated);
          showToast({ kind: "success", title: "Broadcast stream stopped.", subtitle: session.title });
        } catch (err) {
          showToast({ kind: "error", title: "Unable to stop broadcast stream.", subtitle: apiMessage(err, "") });
        }
      });
    },
    async remove(session) {
      return run(session, "delete", async () => {
        try {
          await api.endRealtimeSession(session.id);
          sessions.removeRow(session.id);
          if (controller?.getSnapshot().sessionId === session.id) controller.disconnect();
          showToast({ kind: "success", title: "Class deleted.", subtitle: session.title });
        } catch (err) {
          showToast({ kind: "error", title: "Unable to delete session.", subtitle: apiMessage(err, "") });
        }
      });
    },
  };
}

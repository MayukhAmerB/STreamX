// Promise-based confirmation on top of the shared ConfirmDialog (plan §2.5):
//   const [dialog, confirm] = useConfirm();
//   if (await confirm(confirmCopy("delete", session))) …
//   return <>{…}{dialog}</>;
// Replaces window.confirm / window.prompt in the Classes area. OWNER: WS-D1.
import { useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "../app-shell/ui";

export default function useConfirm() {
  const [request, setRequest] = useState(null);
  const resolverRef = useRef(null);

  const settle = useCallback((value) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(value);
  }, []);

  const confirm = useCallback((copy) => {
    // A second request while one is open answers the first with "no".
    resolverRef.current?.(false);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setRequest(copy || {});
    });
  }, []);

  const dialog = (
    <ConfirmDialog
      open={Boolean(request)}
      title={request?.title || ""}
      objectName={request?.objectName}
      body={request?.body}
      confirmLabel={request?.confirmLabel || "Confirm"}
      danger={Boolean(request?.danger)}
      reason={request?.reason || "none"}
      onConfirm={(reason) => settle(request?.reason && request.reason !== "none" ? { reason } : true)}
      onCancel={() => settle(false)}
    />
  );

  return [dialog, confirm];
}

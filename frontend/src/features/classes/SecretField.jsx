// A labelled value with Copy and (for secrets) Show/Hide: join link, stream
// URL, OBS server URL and stream key. OWNER: WS-D1.
import { Copy, View, ViewOff } from "@carbon/icons-react";
import { IconButton } from "@carbon/react";
import { useEffect, useState } from "react";
import { maskSecretValue } from "./classesModel";

export default function SecretField({ id, label, value, secret = false, emptyText = "Not available yet.", onCopy, resetKey, children }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => setVisible(false), [resetKey]);
  const shown = value ? (secret && !visible ? maskSecretValue(value) : value) : emptyText;
  return (
    <div className="cls-field">
      <p className="cls-label" id={`${id}-label`}>
        {label}
      </p>
      <div className="cls-field__row">
        <code className={`cls-field__value${value ? "" : " is-empty"}`} aria-labelledby={`${id}-label`} data-testid={id}>
          {shown}
        </code>
        {secret ? (
          <IconButton
            kind="ghost"
            size="md"
            align="top"
            label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            disabled={!value}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <ViewOff /> : <View />}
          </IconButton>
        ) : null}
        {onCopy ? (
          <IconButton kind="ghost" size="md" align="top" label={`Copy ${label.toLowerCase()}`} disabled={!value} onClick={onCopy}>
            <Copy />
          </IconButton>
        ) : null}
      </div>
      {children}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";

const DEFAULT_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function scrambleText(text, revealedCount, charset) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (i < revealedCount || !/[A-Za-z0-9]/.test(ch)) {
      out += ch;
      continue;
    }
    out += charset[Math.floor(Math.random() * charset.length)];
  }
  return out;
}

export default function DecryptedText({
  text,
  className = "",
  durationMs = 1300,
  fps = 30,
  charset = DEFAULT_CHARSET,
}) {
  const targetText = useMemo(() => String(text || ""), [text]);
  const [displayText, setDisplayText] = useState(targetText);

  useEffect(() => {
    if (!targetText) {
      setDisplayText("");
      return undefined;
    }

    const frameInterval = Math.max(16, Math.floor(1000 / Math.max(1, fps)));
    const totalFrames = Math.max(1, Math.round(durationMs / frameInterval));
    const revealPerFrame = targetText.length / totalFrames;
    let frame = 0;

    setDisplayText(scrambleText(targetText, 0, charset));
    const timer = setInterval(() => {
      frame += 1;
      const revealedCount = Math.min(targetText.length, Math.floor(frame * revealPerFrame));
      setDisplayText(scrambleText(targetText, revealedCount, charset));
      if (frame >= totalFrames) {
        clearInterval(timer);
        setDisplayText(targetText);
      }
    }, frameInterval);

    return () => clearInterval(timer);
  }, [targetText, durationMs, fps, charset]);

  return (
    <span className={className} aria-label={targetText}>
      <span aria-hidden="true">{displayText}</span>
    </span>
  );
}

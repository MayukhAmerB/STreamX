export function normalizeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function deriveEmbedUrl(baseUrl, targetPath) {
  const raw = normalizeExternalUrl(baseUrl);
  if (!raw) return "";
  const normalizedTargetPath = String(targetPath || "").trim();
  if (!normalizedTargetPath) return "";
  try {
    const parsed = new URL(raw);
    parsed.pathname = normalizedTargetPath.startsWith("/")
      ? normalizedTargetPath
      : `/${normalizedTargetPath}`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function coerceOwncastWritableChatUrl(url) {
  const raw = normalizeExternalUrl(url);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (/^\/embed\/chat(?:\/|$)/i.test(parsed.pathname)) {
      parsed.pathname = "/embed/chat/readwrite";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

export function resolveBroadcastEmbedUrls({ streamEmbedUrl, chatEmbedUrl } = {}) {
  const directStream = normalizeExternalUrl(streamEmbedUrl);
  const directChat = normalizeExternalUrl(chatEmbedUrl);

  const resolvedStreamEmbedUrl =
    directStream || deriveEmbedUrl(directChat, "/embed/video");

  const resolvedChatEmbedUrl =
    directChat || deriveEmbedUrl(directStream, "/embed/chat/readwrite");

  const writableChatEmbedUrl =
    coerceOwncastWritableChatUrl(resolvedChatEmbedUrl) ||
    coerceOwncastWritableChatUrl(deriveEmbedUrl(resolvedStreamEmbedUrl, "/embed/chat/readwrite"));

  return {
    streamEmbedUrl: resolvedStreamEmbedUrl,
    chatEmbedUrl: resolvedChatEmbedUrl,
    writableChatEmbedUrl: normalizeExternalUrl(writableChatEmbedUrl),
  };
}

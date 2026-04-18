import { describe, expect, it } from "vitest";

import { resolveBroadcastEmbedUrls } from "./broadcastUrls";

describe("resolveBroadcastEmbedUrls", () => {
  it("keeps direct stream and chat embed URLs when present", () => {
    const urls = resolveBroadcastEmbedUrls({
      streamEmbedUrl: "https://stream.example.com/embed/video",
      chatEmbedUrl: "https://stream.example.com/embed/chat/readwrite",
    });

    expect(urls.streamEmbedUrl).toBe("https://stream.example.com/embed/video/");
    expect(urls.chatEmbedUrl).toBe("https://stream.example.com/embed/chat/readwrite");
    expect(urls.writableChatEmbedUrl).toBe("https://stream.example.com/embed/chat/readwrite");
  });

  it("derives stream URL from chat host when stream URL is missing", () => {
    const urls = resolveBroadcastEmbedUrls({
      chatEmbedUrl: "https://stream.example.com/embed/chat/readwrite",
    });

    expect(urls.streamEmbedUrl).toBe("https://stream.example.com/embed/video/");
    expect(urls.chatEmbedUrl).toBe("https://stream.example.com/embed/chat/readwrite");
    expect(urls.writableChatEmbedUrl).toBe("https://stream.example.com/embed/chat/readwrite");
  });

  it("coerces owncast readonly chat path into readwrite for presenter popout", () => {
    const urls = resolveBroadcastEmbedUrls({
      streamEmbedUrl: "https://stream.example.com/embed/video",
      chatEmbedUrl: "https://stream.example.com/embed/chat/readonly",
    });

    expect(urls.streamEmbedUrl).toBe("https://stream.example.com/embed/video/");
    expect(urls.chatEmbedUrl).toBe("https://stream.example.com/embed/chat/readonly");
    expect(urls.writableChatEmbedUrl).toBe("https://stream.example.com/embed/chat/readwrite");
  });

  it("rejects non-http protocols and returns empty URLs", () => {
    const urls = resolveBroadcastEmbedUrls({
      streamEmbedUrl: "javascript:alert(1)",
      chatEmbedUrl: "ftp://stream.example.com/embed/chat/readwrite",
    });

    expect(urls.streamEmbedUrl).toBe("");
    expect(urls.chatEmbedUrl).toBe("");
    expect(urls.writableChatEmbedUrl).toBe("");
  });
});

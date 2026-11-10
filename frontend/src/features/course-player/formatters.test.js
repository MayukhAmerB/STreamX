import { describe, expect, it } from "vitest";
import {
  avatarTone,
  formatCount,
  formatDuration,
  formatFileSize,
  formatRelativeTime,
  formatRunningTime,
  getInitials,
} from "./formatters";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

describe("formatDuration", () => {
  it("formats minutes and hours like a video player", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration("bad")).toBe("0:00");
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("formatRunningTime", () => {
  it("summarizes a module's total length", () => {
    expect(formatRunningTime(0)).toBe("");
    expect(formatRunningTime(45 * 60)).toBe("45 min");
    expect(formatRunningTime(80 * 60)).toBe("1 hr 20 min");
    expect(formatRunningTime(120 * 60)).toBe("2 hr");
  });
});

describe("formatRelativeTime", () => {
  it("uses short, familiar relative times", () => {
    expect(formatRelativeTime(ago(10), NOW)).toBe("Just now");
    expect(formatRelativeTime(ago(5 * 60), NOW)).toBe("5m ago");
    expect(formatRelativeTime(ago(2 * 3600), NOW)).toBe("2h ago");
    expect(formatRelativeTime(ago(3 * 86400), NOW)).toBe("3d ago");
    expect(formatRelativeTime(ago(14 * 86400), NOW)).toBe("2w ago");
  });

  it("falls back to a date for old comments and ignores bad input", () => {
    expect(formatRelativeTime("2026-03-12T10:00:00Z", NOW)).toBe("12 Mar");
    expect(formatRelativeTime("2024-03-12T10:00:00Z", NOW)).toBe("12 Mar 2024");
    expect(formatRelativeTime("", NOW)).toBe("");
    expect(formatRelativeTime("not a date", NOW)).toBe("");
  });

  it("never shows a negative age for clock skew", () => {
    expect(formatRelativeTime(new Date(NOW + 60000).toISOString(), NOW)).toBe("Just now");
  });
});

describe("formatCount", () => {
  it("compacts large numbers", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(950)).toBe("950");
    expect(formatCount(1250)).toBe("1.2K");
    expect(formatCount(25400)).toBe("25K");
    expect(formatCount(2_300_000)).toBe("2.3M");
  });
});

describe("getInitials / avatarTone", () => {
  it("builds avatar initials", () => {
    expect(getInitials("Asha Rao")).toBe("AR");
    expect(getInitials("imran")).toBe("I");
    expect(getInitials("  Mohd  Imran  Syed ")).toBe("MS");
    expect(getInitials("")).toBe("?");
  });

  it("picks a stable colour bucket", () => {
    expect(avatarTone(7)).toBe(avatarTone("7"));
    expect(avatarTone("Asha")).toBeGreaterThanOrEqual(0);
    expect(avatarTone("Asha")).toBeLessThan(6);
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

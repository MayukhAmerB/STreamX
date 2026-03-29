import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DefaultReconnectPolicy, Room, RoomEvent, Track, VideoQuality } from "livekit-client";
import Button from "../Button";
import meetingAdminLogo from "../../assets/logo.jpeg";
import {
  createRealtimeOwncastChatLaunch,
  deleteRealtimeRecording,
  grantRealtimePresenter,
  grantRealtimeSpeaker,
  listRealtimeRecordings,
  revokeRealtimePresenter,
  revokeRealtimeSpeaker,
  startRealtimeRecording,
  stopRealtimeRecording,
  uploadRealtimeBrowserRecording,
} from "../../api/realtime";
import { useAuth } from "../../hooks/useAuth";
import { ScreenityFallbackRecorder } from "../../services/recording/ScreenityFallbackRecorder";
import { resolveBroadcastEmbedUrls } from "../../utils/broadcastUrls";
import { apiData, apiMessage } from "../../utils/api";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const DEFAULT_MEETING_MEDIA_PROFILE = {
  camera_capture_width: 1280,
  camera_capture_height: 720,
  camera_fps: 24,
  camera_max_video_bitrate_kbps: 1200,
  screen_capture_width: 1920,
  screen_capture_height: 1080,
  screen_fps: 15,
  screen_max_video_bitrate_kbps: 2500,
};

const meetingShellBackgroundImage =
  "https://i.pinimg.com/736x/e7/18/de/e718de74d25e0e9a2cf62cd126b3abb5.jpg";
const MAX_STAGE_PARTICIPANTS = 5;
const ROOM_STATE_REFRESH_DEBOUNCE_MS = 120;
const MOBILE_LISTENER_RECONNECT_DELAYS_MS = [
  0,
  500,
  1500,
  3000,
  5000,
  7000,
  7000,
  7000,
  7000,
  7000,
  7000,
  7000,
  7000,
  7000,
  7000,
];

function resolveMeetingConnectionStrategy({
  audienceFocusMode = false,
  canPresent = false,
  canSpeak = false,
} = {}) {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      isMobileDevice: false,
      mobileListener: false,
      saveData: false,
      effectiveType: "",
      preferRelayTransport: false,
      conservativeReceiveProfile: false,
    };
  }

  const userAgent = String(navigator.userAgent || "").toLowerCase();
  const viewportWidth = Number(window.innerWidth || 0);
  const touchCapable = Number(navigator.maxTouchPoints || 0) > 1;
  const mobileUserAgent = /android|iphone|ipad|ipod|mobile|iemobile|opera mini/i.test(userAgent);
  const isMobileDevice =
    mobileUserAgent || (touchCapable && viewportWidth > 0 && viewportWidth <= 1024);

  const connection =
    navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  const effectiveType = String(connection?.effectiveType || "").trim().toLowerCase();
  const saveData = connection?.saveData === true;
  const weakNetwork = ["slow-2g", "2g", "3g"].includes(effectiveType);
  const mobileListener = Boolean(isMobileDevice && !canPresent && !canSpeak);
  const preferRelayTransport = Boolean(mobileListener || saveData || weakNetwork);
  const conservativeReceiveProfile = Boolean(
    mobileListener || audienceFocusMode || saveData || weakNetwork
  );

  return {
    isMobileDevice,
    mobileListener,
    saveData,
    effectiveType,
    preferRelayTransport,
    conservativeReceiveProfile,
  };
}

function clampWholeNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const rounded = Math.round(numeric);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}

function normalizeMeetingMediaProfile(profile = {}) {
  return {
    cameraCaptureWidth: clampWholeNumber(
      profile.camera_capture_width,
      320,
      1920,
      DEFAULT_MEETING_MEDIA_PROFILE.camera_capture_width
    ),
    cameraCaptureHeight: clampWholeNumber(
      profile.camera_capture_height,
      180,
      1080,
      DEFAULT_MEETING_MEDIA_PROFILE.camera_capture_height
    ),
    cameraFps: clampWholeNumber(profile.camera_fps, 10, 30, DEFAULT_MEETING_MEDIA_PROFILE.camera_fps),
    cameraMaxVideoBitrateKbps: clampWholeNumber(
      profile.camera_max_video_bitrate_kbps,
      200,
      6000,
      DEFAULT_MEETING_MEDIA_PROFILE.camera_max_video_bitrate_kbps
    ),
    screenCaptureWidth: clampWholeNumber(
      profile.screen_capture_width,
      640,
      3840,
      DEFAULT_MEETING_MEDIA_PROFILE.screen_capture_width
    ),
    screenCaptureHeight: clampWholeNumber(
      profile.screen_capture_height,
      360,
      2160,
      DEFAULT_MEETING_MEDIA_PROFILE.screen_capture_height
    ),
    screenFps: clampWholeNumber(profile.screen_fps, 5, 30, DEFAULT_MEETING_MEDIA_PROFILE.screen_fps),
    screenMaxVideoBitrateKbps: clampWholeNumber(
      profile.screen_max_video_bitrate_kbps,
      500,
      12000,
      DEFAULT_MEETING_MEDIA_PROFILE.screen_max_video_bitrate_kbps
    ),
  };
}

function buildVideoCaptureOptions(width, height, fps) {
  return {
    resolution: { width, height },
    frameRate: fps,
  };
}

function buildVideoPublishOptions(maxVideoBitrateKbps, maxFramerate) {
  return {
    simulcast: true,
    videoEncoding: {
      maxBitrate: Math.max(150000, maxVideoBitrateKbps * 1000),
      maxFramerate,
    },
    degradationPreference: "balanced",
  };
}

function buildScreenShareCaptureOptions(profile) {
  return {
    audio: false,
    video: { displaySurface: "monitor" },
    resolution: {
      width: profile.screenCaptureWidth,
      height: profile.screenCaptureHeight,
      frameRate: profile.screenFps,
    },
    selfBrowserSurface: "include",
    monitorTypeSurfaces: "include",
    preferCurrentTab: false,
    surfaceSwitching: "include",
    systemAudio: "include",
    contentHint: "detail",
  };
}

function buildScreenShareFallbackOptions(profile) {
  return {
    audio: false,
    video: true,
    resolution: {
      width: profile.screenCaptureWidth,
      height: profile.screenCaptureHeight,
      frameRate: profile.screenFps,
    },
    contentHint: "detail",
  };
}

function buildScreenSharePublishOptions(maxVideoBitrateKbps, maxFramerate) {
  return {
    simulcast: false,
    videoEncoding: {
      maxBitrate: Math.max(500000, maxVideoBitrateKbps * 1000),
      maxFramerate,
    },
    degradationPreference: "maintain-resolution",
  };
}

function hasMediaCaptureApi() {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

function mediaPermissionHelpMessage(feature = "microphone") {
  return `${feature} access is unavailable on this URL. Open the app over HTTPS (or localhost in dev) and allow browser permission.`;
}

function resolveControlError(err, fallbackError, feature = "microphone") {
  const rawMessage = String(err?.message || "");
  const normalized = rawMessage.toLowerCase();
  if (normalized.includes("getusermedia") || normalized.includes("mediadevices")) {
    return mediaPermissionHelpMessage(feature);
  }
  if (normalized.includes("notallowederror") || normalized.includes("permission denied")) {
    return `Browser denied ${feature} permission. Allow it in site settings and retry.`;
  }
  if (normalized.includes("notfounderror") || normalized.includes("requested device not found")) {
    return `No ${feature} device was found on this system.`;
  }
  return rawMessage || fallbackError;
}

function getLocalCameraCaptureSummary(localParticipant) {
  try {
    const cameraPublication = localParticipant?.getTrackPublication?.(Track.Source.Camera);
    const localVideoTrack = cameraPublication?.videoTrack || cameraPublication?.track;
    const mediaStreamTrack = localVideoTrack?.mediaStreamTrack;
    if (!mediaStreamTrack || typeof mediaStreamTrack.getSettings !== "function") {
      return null;
    }
    const settings = mediaStreamTrack.getSettings() || {};
    const width = Number(settings.width || 0);
    const height = Number(settings.height || 0);
    const fps = Number(settings.frameRate || 0);
    if (!width || !height) {
      return null;
    }
    return {
      width: Math.round(width),
      height: Math.round(height),
      fps: fps > 0 ? Math.round(fps) : null,
    };
  } catch {
    return null;
  }
}

async function enableCameraWithProfile(localParticipant, profile) {
  const captureOptions = buildVideoCaptureOptions(
    profile.cameraCaptureWidth,
    profile.cameraCaptureHeight,
    profile.cameraFps
  );
  const publishOptions = buildVideoPublishOptions(
    profile.cameraMaxVideoBitrateKbps,
    profile.cameraFps
  );

  // Re-publish camera when turning it on so the latest admin-selected profile is always applied.
  const existingCameraPublication = localParticipant.getTrackPublication(Track.Source.Camera);
  if (existingCameraPublication?.track) {
    try {
      await localParticipant.unpublishTrack(existingCameraPublication.track, true);
    } catch {
      // Fall through and try enabling camera anyway.
    }
  }

  try {
    await localParticipant.setCameraEnabled(true, captureOptions, publishOptions);
  } catch (primaryError) {
    try {
      await localParticipant.setCameraEnabled(true, captureOptions);
    } catch (secondaryError) {
      await localParticipant.setCameraEnabled(true);
      throw secondaryError || primaryError;
    }
  }
}

async function enableScreenShareWithProfile(localParticipant, profile) {
  const publishOptions = buildScreenSharePublishOptions(
    profile.screenMaxVideoBitrateKbps,
    profile.screenFps
  );
  try {
    await localParticipant.setScreenShareEnabled(true, buildScreenShareCaptureOptions(profile), publishOptions);
  } catch {
    await localParticipant.setScreenShareEnabled(true, buildScreenShareFallbackOptions(profile), publishOptions);
  }
}

function participantLabel(entry) {
  const name = entry.participant?.name || entry.participant?.identity || "Participant";
  return entry.isLocal ? `${name} (You)` : name;
}

function publicationHasActiveTrack(publication) {
  if (!publication?.track) {
    return false;
  }
  if (publication.isMuted === true || publication.isEnabled === false) {
    return false;
  }
  if (publication.track?.isMuted === true || publication.track?.isEnabled === false) {
    return false;
  }
  return true;
}

function buildParticipantMediaStateKey(participant) {
  const publications = Array.from(participant?.trackPublications?.values?.() || [])
    .map((publication) => {
      const source = String(publication?.source || publication?.kind || "unknown");
      const trackSid = String(publication?.trackSid || publication?.track?.sid || "");
      const hasTrack = publication?.track ? "1" : "0";
      const publicationMuted = publication?.isMuted === true ? "1" : "0";
      const publicationEnabled = publication?.isEnabled === false ? "0" : "1";
      const trackMuted = publication?.track?.isMuted === true ? "1" : "0";
      const trackEnabled = publication?.track?.isEnabled === false ? "0" : "1";
      return `${source}:${trackSid}:${hasTrack}:${publicationMuted}:${publicationEnabled}:${trackMuted}:${trackEnabled}`;
    })
    .sort();

  return publications.join("|");
}

function getParticipantMediaState(participant) {
  const publications = Array.from(participant.trackPublications.values());

  const screenVideoPublication = publications.find(
    (publication) =>
      publication.source === Track.Source.ScreenShare &&
      publication.kind === Track.Kind.Video &&
      publicationHasActiveTrack(publication)
  );
  const cameraVideoPublication = publications.find(
    (publication) =>
      publication.source === Track.Source.Camera &&
      publication.kind === Track.Kind.Video &&
      publicationHasActiveTrack(publication)
  );
  const audioPublication =
    publications.find(
      (publication) =>
        publication.source === Track.Source.Microphone &&
        publication.kind === Track.Kind.Audio &&
        publicationHasActiveTrack(publication)
    ) ||
    publications.find(
      (publication) => publication.kind === Track.Kind.Audio && publicationHasActiveTrack(publication)
    );

  const hasScreenShare = Boolean(screenVideoPublication);
  const hasCamera = Boolean(cameraVideoPublication);
  const hasAudio = Boolean(audioPublication);

  return {
    hasScreenShare,
    hasCamera,
    hasAudio,
    videoTrack: (screenVideoPublication || cameraVideoPublication || {}).track || null,
    audioTrack: (audioPublication || {}).track || null,
  };
}

function participantInitials(label) {
  const normalized = String(label || "")
    .replace(/\(You\)/g, "")
    .trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "P";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase();
  }
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function humanizeConnectionLabel(label) {
  const normalized = String(label || "connecting")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!normalized) {
    return "Connecting";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function parseParticipantMetadata(participant) {
  const rawMetadata = String(participant?.metadata || "").trim();
  if (!rawMetadata) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function MeetingTile({ entry, isFeatured = false, isSpeaking = false, isPinned = false, onPin }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  // Re-evaluate media state on each render so track switches (camera <-> screen) apply immediately.
  const mediaState = getParticipantMediaState(entry.participant);
  const displayName = participantLabel(entry);
  const initials = participantInitials(displayName);
  const profileImageUrl = String(entry?.profileImageUrl || "").trim();
  const tileHeightClass = isFeatured
    ? mediaState.hasScreenShare
      ? "h-[46vh] min-h-[220px] sm:h-[56vh] lg:h-[560px]"
      : "h-[40vh] min-h-[200px] sm:h-[46vh] lg:h-[420px]"
    : "h-[180px] sm:h-[200px] lg:h-[210px]";
  const videoFitClass = mediaState.hasScreenShare ? "object-contain bg-black" : "object-cover";

  useEffect(() => {
    if (!videoRef.current || !mediaState.videoTrack) {
      return undefined;
    }

    mediaState.videoTrack.attach(videoRef.current);
    videoRef.current
      .play()
      .catch(() => {
        // no-op: browser autoplay policies can reject the promise even when video still renders
      });
    return () => {
      mediaState.videoTrack.detach(videoRef.current);
    };
  }, [mediaState.videoTrack]);

  useEffect(() => {
    if (entry.isLocal || !audioRef.current || !mediaState.audioTrack) {
      return undefined;
    }

    mediaState.audioTrack.attach(audioRef.current);
    return () => {
      mediaState.audioTrack.detach(audioRef.current);
    };
  }, [entry.isLocal, mediaState.audioTrack]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [profileImageUrl]);

  return (
    <article
      className={`group relative overflow-hidden rounded-[24px] border ${
        isSpeaking
          ? "border-[#C0C0C0]/70 shadow-[0_0_0_1px_rgba(192,192,192,0.28),0_24px_36px_rgba(0,0,0,0.28)]"
          : "border-black shadow-[0_16px_32px_rgba(0,0,0,0.22)]"
      } bg-[#0F0F0F]/95`}
    >
      <div className={`${tileHeightClass} relative w-full bg-[#101010]`}>
        {mediaState.videoTrack ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={entry.isLocal}
            className={`h-full w-full ${videoFitClass}`}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_top,rgba(192,192,192,0.14),transparent_38%),linear-gradient(180deg,#171717_0%,#0D0D0D_100%)] px-6 text-center">
            {profileImageUrl && !avatarFailed ? (
              <img
                src={profileImageUrl}
                alt={displayName}
                className="h-24 w-24 rounded-full border border-black object-cover shadow-[0_10px_22px_rgba(0,0,0,0.28)]"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#252525] text-2xl font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                {initials}
              </div>
            )}
            <div className="mt-4 text-sm font-medium text-white">{displayName}</div>
            <div className="mt-1 text-xs text-[#BBBBBB]">
              {mediaState.hasAudio ? "Audio connected" : "Camera off"}
            </div>
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/72 via-transparent to-black/10" />

        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
          {entry.isLocal ? (
            <span className="rounded-full border border-black bg-[#161616]/88 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#E1E1E1]">
              You
            </span>
          ) : null}
          {isSpeaking ? (
            <span className="rounded-full border border-[#C0C0C0]/40 bg-[#C0C0C0]/16 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#F1F1F1]">
              Speaking
            </span>
          ) : null}
          {mediaState.hasScreenShare ? (
            <span className="rounded-full border border-black bg-[#161616]/88 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#E1E1E1]">
              Presenting
            </span>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onPin}
          className="absolute right-3 top-3 rounded-full border border-black bg-[#161616]/88 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#E1E1E1] transition hover:bg-[#1D1D1D]"
        >
          {isPinned ? "Unpin" : "Pin"}
        </button>
      </div>

      <div className="absolute inset-x-0 bottom-0 px-3 py-3">
        <div className="flex items-end justify-between gap-3 rounded-2xl border border-black bg-[#161616]/82 px-3 py-2.5 backdrop-blur">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{displayName}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="rounded-full border border-black bg-black/20 px-2 py-0.5 text-[10px] text-[#E1E1E1]">
                {mediaState.hasAudio ? "Mic live" : "Muted"}
              </span>
              <span className="rounded-full border border-black bg-black/20 px-2 py-0.5 text-[10px] text-[#E1E1E1]">
                {mediaState.hasCamera ? "Camera on" : "Camera off"}
              </span>
              {isPinned ? (
                <span className="rounded-full border border-black bg-black/20 px-2 py-0.5 text-[10px] text-[#E1E1E1]">
                  Pinned
                </span>
              ) : null}
            </div>
          </div>
          <div
            className={`h-2.5 w-2.5 flex-none rounded-full ${
              mediaState.hasAudio ? "bg-[#7C7C7C]" : "bg-[#626262]"
            }`}
          />
        </div>
      </div>

      {!entry.isLocal ? <audio ref={audioRef} autoPlay /> : null}
    </article>
  );
}

const MemoMeetingTile = memo(MeetingTile, (prev, next) => {
  return (
    prev.entry?.id === next.entry?.id &&
    prev.entry?.participant === next.entry?.participant &&
    prev.entry?.isLocal === next.entry?.isLocal &&
    prev.entry?.profileImageUrl === next.entry?.profileImageUrl &&
    prev.entry?.mediaStateKey === next.entry?.mediaStateKey &&
    prev.isFeatured === next.isFeatured &&
    prev.isSpeaking === next.isSpeaking &&
    prev.isPinned === next.isPinned
  );
});

function buildJoinLink(session) {
  if (session?.join_url) {
    return session.join_url;
  }
  const sessionId = session?.id;
  if (!sessionId) {
    return "";
  }
  if (typeof window === "undefined") {
    return `/join-live?session=${sessionId}`;
  }
  return `${window.location.origin}/join-live?session=${sessionId}`;
}

function parseUserIdFromIdentity(identity) {
  const match = /^user-(\d+)-/.exec(identity || "");
  if (!match) {
    return null;
  }
  const userId = Number(match[1]);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function sourceIncludesMicrophone(sourceValue) {
  const normalized = String(sourceValue || "").trim().toLowerCase();
  return normalized.includes("microphone") || normalized === "mic";
}

function sourceIncludesPresenterMedia(sourceValue) {
  const normalized = String(sourceValue || "").trim().toLowerCase();
  return (
    normalized.includes("camera") ||
    normalized.includes("screen_share") ||
    normalized.includes("screen-share") ||
    normalized.includes("screenshare") ||
    normalized.includes("screen")
  );
}

function extractLocalCanSpeakFromPermissions(participant) {
  const permissions = participant?.permissions || participant?.permission;
  if (!permissions || typeof permissions !== "object") {
    return null;
  }
  const canPublish = Boolean(permissions.canPublish);
  const rawSources = Array.isArray(permissions.canPublishSources)
    ? permissions.canPublishSources
    : [];
  if (rawSources.length === 0) {
    return canPublish;
  }
  return canPublish && rawSources.some((source) => sourceIncludesMicrophone(source));
}

function extractLocalCanPresentFromPermissions(participant) {
  const permissions = participant?.permissions || participant?.permission;
  if (!permissions || typeof permissions !== "object") {
    return null;
  }
  const canPublish = Boolean(permissions.canPublish);
  const rawSources = Array.isArray(permissions.canPublishSources)
    ? permissions.canPublishSources
    : [];
  if (rawSources.length === 0) {
    return canPublish;
  }
  return canPublish && rawSources.some((source) => sourceIncludesPresenterMedia(source));
}

function resolvePermissionEventParticipant(firstArg, secondArg) {
  const firstLooksLikeParticipant =
    firstArg && typeof firstArg === "object" && typeof firstArg.identity === "string";
  if (firstLooksLikeParticipant) {
    return firstArg;
  }
  const secondLooksLikeParticipant =
    secondArg && typeof secondArg === "object" && typeof secondArg.identity === "string";
  if (secondLooksLikeParticipant) {
    return secondArg;
  }
  return null;
}

function resolveRecordingMode(recording) {
  const source = String(recording?.source || "").trim().toLowerCase();
  if (source === "browser_fallback") {
    return "screenity-fallback";
  }
  if (recording?.is_active) {
    return "livekit-egress";
  }
  return "";
}

function resolveRecordingPlaybackUrl(recording) {
  return String(recording?.playback_url || recording?.output_download_url || "").trim();
}

function normalizeUserIdList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))].sort(
    (a, b) => a - b
  );
}

export default function MeetingRoomExperience({ payload, onLeave, audiencePanel = false }) {
  const { user } = useAuth();
  const session = payload?.session || {};
  const meeting = payload?.meeting || {};
  const isBroadcastControlSession = session?.session_type === "broadcasting";
  const broadcastEmbedUrls = useMemo(() => {
    if (!isBroadcastControlSession) {
      return { streamEmbedUrl: "", chatEmbedUrl: "", writableChatEmbedUrl: "" };
    }
    return resolveBroadcastEmbedUrls({
      streamEmbedUrl: session?.stream_embed_url,
      chatEmbedUrl: session?.chat_embed_url,
    });
  }, [isBroadcastControlSession, session?.stream_embed_url, session?.chat_embed_url]);
  const broadcastMonitorUrl = broadcastEmbedUrls.streamEmbedUrl;
  const broadcastChatUrl =
    broadcastEmbedUrls.writableChatEmbedUrl || broadcastEmbedUrls.chatEmbedUrl;
  const canPresentFromPayload = Boolean(meeting?.permissions?.can_present);
  const canSpeakFromPayload = Boolean(meeting?.permissions?.can_speak || canPresentFromPayload);
  const canManageParticipants = Boolean(
    meeting?.permissions?.can_manage_participants ?? meeting?.permissions?.can_manage_presenters
  );
  const audienceFocusMode = Boolean(audiencePanel && !canManageParticipants);
  const mediaProfile = useMemo(() => normalizeMeetingMediaProfile(meeting?.media_profile || {}), [meeting?.media_profile]);
  const premiumProfileEnabled = useMemo(
    () =>
      mediaProfile.cameraCaptureWidth >= 1920 &&
      mediaProfile.cameraCaptureHeight >= 1080 &&
      mediaProfile.cameraFps >= 30 &&
      mediaProfile.cameraMaxVideoBitrateKbps >= 3000 &&
      mediaProfile.screenCaptureWidth >= 1920 &&
      mediaProfile.screenCaptureHeight >= 1080 &&
      mediaProfile.screenFps >= 30 &&
      mediaProfile.screenMaxVideoBitrateKbps >= 5000,
    [mediaProfile]
  );
  const connectionStrategy = useMemo(
    () =>
      resolveMeetingConnectionStrategy({
        audienceFocusMode,
        canPresent: canPresentFromPayload,
        canSpeak: canSpeakFromPayload,
      }),
    [audienceFocusMode, canPresentFromPayload, canSpeakFromPayload]
  );
  const reconnectPolicy = useMemo(() => {
    if (connectionStrategy.preferRelayTransport) {
      return new DefaultReconnectPolicy(MOBILE_LISTENER_RECONNECT_DELAYS_MS);
    }
    return new DefaultReconnectPolicy();
  }, [connectionStrategy.preferRelayTransport]);

  const [meetingError, setMeetingError] = useState("");
  const [meetingInfo, setMeetingInfo] = useState("");
  const [connecting, setConnecting] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connectionLabel, setConnectionLabel] = useState("Connecting");
  const [participants, setParticipants] = useState([]);
  const [activeSpeakerIds, setActiveSpeakerIds] = useState([]);
  const [pinnedIdentity, setPinnedIdentity] = useState("");
  const [controlBusy, setControlBusy] = useState(false);
  const [controls, setControls] = useState({ mic: true, camera: true, screen: false });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [panelTab, setPanelTab] = useState("people");
  const [sidePanelOpen, setSidePanelOpen] = useState(!audienceFocusMode);
  const [presenterUserIds, setPresenterUserIds] = useState(() => normalizeUserIdList(meeting.presenter_user_ids));
  const [speakerUserIds, setSpeakerUserIds] = useState(() => normalizeUserIdList(meeting.speaker_user_ids));
  const [runtimeCanPresent, setRuntimeCanPresent] = useState(Boolean(canPresentFromPayload));
  const [runtimeCanSpeak, setRuntimeCanSpeak] = useState(Boolean(canSpeakFromPayload));
  const [permissionState, setPermissionState] = useState({
    loadingKey: "",
    error: "",
    info: "",
  });
  const [recordingState, setRecordingState] = useState({
    loading: false,
    error: "",
    info: "",
    active: null,
    latestCompleted: null,
    mode: "",
  });

  const roomRef = useRef(null);
  const connectedAtRef = useRef(null);
  const stageRef = useRef(null);
  const fallbackRecorderRef = useRef(null);
  const roomStateRefreshTimerRef = useRef(null);
  const [isStageFullscreen, setIsStageFullscreen] = useState(false);
  const defaultModeratorUserIds = useMemo(
    () =>
      normalizeUserIdList([
        session?.host?.id,
        session?.linked_course?.instructor_id,
      ]),
    [session?.host?.id, session?.linked_course?.instructor_id]
  );

  const syncParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipants([]);
      return;
    }

    const buildParticipantEntry = (participant, isLocal) => {
      const participantMetadata = parseParticipantMetadata(participant);
      const authUserProfileImageUrl = isLocal ? String(user?.profile_image_url || "").trim() : "";
      const shouldUseAdminLogo =
        Boolean(participantMetadata?.is_admin) || Boolean(isLocal && user?.is_admin);
      const profileImageUrl = String(
        (isLocal ? meeting?.participant_profile_image_url : "") ||
          participantMetadata.profile_image_url ||
          participantMetadata.profileImageUrl ||
          authUserProfileImageUrl ||
          (shouldUseAdminLogo ? meetingAdminLogo : "") ||
          ""
      ).trim();

      return {
        id: participant.identity || participant.sid,
        participant,
        isLocal,
        participantMetadata,
        profileImageUrl,
        mediaStateKey: buildParticipantMediaStateKey(participant),
      };
    };

    const localEntry = room.localParticipant
      ? [buildParticipantEntry(room.localParticipant, true)]
      : [];
    const remoteEntries = Array.from(room.remoteParticipants.values()).map((participant) =>
      buildParticipantEntry(participant, false)
    );

    setParticipants([...localEntry, ...remoteEntries]);
  }, [meeting?.participant_profile_image_url, user?.is_admin, user?.profile_image_url]);

  const syncLocalControls = useCallback(() => {
    const room = roomRef.current;
    if (!room?.localParticipant) {
      return;
    }
    const localState = getParticipantMediaState(room.localParticipant);
    setControls({
      mic: localState.hasAudio,
      camera: localState.hasCamera,
      screen: localState.hasScreenShare,
    });
  }, []);

  const enforceRemotePublicationQuality = useCallback(
    (publication) => {
      if (
        connectionStrategy.conservativeReceiveProfile ||
        !premiumProfileEnabled ||
        !publication ||
        publication.kind !== Track.Kind.Video
      ) {
        return;
      }
      try {
        if (typeof publication.setVideoQuality === "function") {
          publication.setVideoQuality(VideoQuality.HIGH);
        }
        if (typeof publication.setVideoFPS === "function") {
          publication.setVideoFPS(Math.max(24, mediaProfile.screenFps));
        }
        if (typeof publication.setVideoDimensions === "function") {
          publication.setVideoDimensions({
            width: mediaProfile.screenCaptureWidth,
            height: mediaProfile.screenCaptureHeight,
          });
        }
      } catch {
        // best-effort quality hints
      }
    },
    [
      connectionStrategy.conservativeReceiveProfile,
      mediaProfile.screenCaptureHeight,
      mediaProfile.screenCaptureWidth,
      mediaProfile.screenFps,
      premiumProfileEnabled,
    ]
  );

  useEffect(() => {
    setPresenterUserIds(normalizeUserIdList(meeting.presenter_user_ids));
    setSpeakerUserIds(normalizeUserIdList(meeting.speaker_user_ids));
    setPermissionState({ loadingKey: "", error: "", info: "" });
  }, [meeting.presenter_user_ids, meeting.speaker_user_ids, session.id]);

  useEffect(() => {
    setRuntimeCanPresent(Boolean(canPresentFromPayload));
    setRuntimeCanSpeak(Boolean(canSpeakFromPayload || canPresentFromPayload));
  }, [canPresentFromPayload, canSpeakFromPayload, session.id]);

  useEffect(() => {
    setSidePanelOpen(!audienceFocusMode);
  }, [audienceFocusMode, session.id]);

  useEffect(() => {
    let active = true;
    if (!session.id) {
      setRecordingState({
        loading: false,
        error: "",
        info: "",
        active: null,
        latestCompleted: null,
        mode: "",
      });
      return undefined;
    }
    (async () => {
      try {
        const response = await listRealtimeRecordings(session.id);
        if (!active) return;
        const payload = apiData(response, []);
        const rows = Array.isArray(payload) ? payload : [];
        const activeRecording = rows.find((item) => item?.is_active) || null;
        const latestCompleted = rows.find((item) => item?.status === "completed") || null;
        setRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "",
          active: activeRecording,
          latestCompleted,
          mode: resolveRecordingMode(activeRecording),
        }));
      } catch {
        if (!active) return;
        setRecordingState((prev) => ({ ...prev, loading: false }));
      }
    })();
    return () => {
      active = false;
    };
  }, [session.id]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsStageFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      const recorder = fallbackRecorderRef.current;
      if (recorder?.isRecording) {
        recorder.stop().catch(() => {
          // best-effort cleanup
        });
      }
      fallbackRecorderRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!meeting.livekit_url || !meeting.token) {
      setMeetingError("Meeting credentials are missing.");
      setConnecting(false);
      setConnected(false);
      return undefined;
    }

    let disposed = false;
    const room = new Room({
      adaptiveStream: connectionStrategy.conservativeReceiveProfile ? true : !premiumProfileEnabled,
      dynacast: true,
      reconnectPolicy,
    });
    roomRef.current = room;

    setMeetingError("");
    setMeetingInfo("");
    setConnecting(true);
    setConnected(false);
    setConnectionLabel("Connecting");
    setParticipants([]);
    setMessages([]);
    setPinnedIdentity("");
    setActiveSpeakerIds([]);
    setElapsedSeconds(0);

    const flushRoomStateRefresh = () => {
      if (roomStateRefreshTimerRef.current) {
        window.clearTimeout(roomStateRefreshTimerRef.current);
        roomStateRefreshTimerRef.current = null;
      }
      syncParticipants();
      syncLocalControls();
    };
    const scheduleRoomStateRefresh = () => {
      if (roomStateRefreshTimerRef.current) {
        return;
      }
      roomStateRefreshTimerRef.current = window.setTimeout(() => {
        roomStateRefreshTimerRef.current = null;
        syncParticipants();
        syncLocalControls();
      }, ROOM_STATE_REFRESH_DEBOUNCE_MS);
    };

    room.on(RoomEvent.ParticipantConnected, scheduleRoomStateRefresh);
    room.on(RoomEvent.ParticipantDisconnected, scheduleRoomStateRefresh);
    room.on(RoomEvent.TrackPublished, scheduleRoomStateRefresh);
    room.on(RoomEvent.TrackUnpublished, scheduleRoomStateRefresh);
    room.on(RoomEvent.LocalTrackPublished, scheduleRoomStateRefresh);
    room.on(RoomEvent.LocalTrackUnpublished, scheduleRoomStateRefresh);
    room.on(RoomEvent.TrackMuted, scheduleRoomStateRefresh);
    room.on(RoomEvent.TrackUnmuted, scheduleRoomStateRefresh);
    room.on(RoomEvent.ParticipantMetadataChanged, scheduleRoomStateRefresh);
    room.on(RoomEvent.ParticipantNameChanged, scheduleRoomStateRefresh);
    room.on(RoomEvent.TrackSubscribed, (_track, publication) => {
      enforceRemotePublicationQuality(publication);
      scheduleRoomStateRefresh();
    });
    room.on(RoomEvent.TrackUnsubscribed, scheduleRoomStateRefresh);
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      setActiveSpeakerIds(speakers.map((speaker) => speaker.identity));
    });
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      setConnectionLabel(state);
    });
    room.on(RoomEvent.Reconnecting, () => {
      setMeetingInfo("Reconnecting...");
      setConnectionLabel("reconnecting");
    });
    room.on(RoomEvent.Reconnected, () => {
      setMeetingInfo("Connection restored.");
      setConnectionLabel("connected");
    });
    room.on(RoomEvent.Disconnected, () => {
      setConnected(false);
      setConnecting(false);
      setConnectionLabel("disconnected");
      flushRoomStateRefresh();
    });
    const permissionsChangedEvent =
      RoomEvent.ParticipantPermissionsChanged || "participantPermissionsChanged";
    room.on(permissionsChangedEvent, (firstArg, secondArg) => {
      const participant = resolvePermissionEventParticipant(firstArg, secondArg);
      if (!participant || participant.identity !== room.localParticipant?.identity) {
        return;
      }
      const canSpeakFromPermissions = extractLocalCanSpeakFromPermissions(participant);
      const canPresentFromPermissions = extractLocalCanPresentFromPermissions(participant);
      if (
        typeof canSpeakFromPermissions !== "boolean" &&
        typeof canPresentFromPermissions !== "boolean"
      ) {
        return;
      }
      const nextCanPresent =
        typeof canPresentFromPermissions === "boolean"
          ? canPresentFromPermissions
          : Boolean(canPresentFromPayload);
      const nextCanSpeak =
        typeof canSpeakFromPermissions === "boolean"
          ? canSpeakFromPermissions
          : Boolean(canSpeakFromPayload || canPresentFromPayload);
      setRuntimeCanPresent(Boolean(nextCanPresent));
      setRuntimeCanSpeak(nextCanSpeak);
      if (!nextCanSpeak) {
        room.localParticipant
          .setMicrophoneEnabled(false)
          .catch(() => {
            // best-effort immediate mute on revoke
          });
      }
      if (!nextCanPresent) {
        room.localParticipant
          .setCameraEnabled(false)
          .catch(() => {
            // best-effort immediate camera stop on revoke
          });
        room.localParticipant
          .setScreenShareEnabled(false)
          .catch(() => {
            // best-effort immediate screenshare stop on revoke
          });
      }
      setMeetingInfo(
        nextCanPresent
          ? nextCanSpeak
            ? "Stage + microphone access granted by moderator."
            : "Stage access granted. Camera/screen share are enabled; microphone is still locked."
          : nextCanSpeak
            ? "Microphone access granted by moderator. You can unmute now."
            : "Microphone access revoked by moderator."
      );
      syncLocalControls();
    });
    room.on(RoomEvent.DataReceived, (payloadBytes, participant, _kind, topic) => {
      if (topic && topic !== "meeting-chat" && topic !== "meeting-control") {
        return;
      }

      try {
        const decoded = textDecoder.decode(payloadBytes);
        const parsed = JSON.parse(decoded);
        if (parsed?.type === "permission_update" && parsed?.permission === "speaker") {
          const targetUserId = Number(parsed?.target_user_id || 0);
          const shouldAllowSpeak = Boolean(parsed?.can_speak);
          const senderMetadata = parseParticipantMetadata(participant);
          const senderRole = String(senderMetadata?.role || "").trim().toLowerCase();
          const senderIsModerator = Boolean(senderMetadata?.is_admin || senderRole === "instructor");
          if (!senderIsModerator || !Number.isInteger(targetUserId) || targetUserId <= 0) {
            return;
          }
          setSpeakerUserIds((previous) => {
            const normalized = normalizeUserIdList(previous);
            if (shouldAllowSpeak) {
              return normalizeUserIdList([...normalized, targetUserId]);
            }
            return normalized.filter((value) => value !== targetUserId);
          });
          if (targetUserId === Number(user?.id || 0)) {
            setRuntimeCanSpeak(Boolean(shouldAllowSpeak || hasSpeakerAccess(Number(user?.id || 0))));
            if (!shouldAllowSpeak) {
              room.localParticipant
                .setMicrophoneEnabled(false)
                .catch(() => {
                  // best-effort immediate mute on revoke
                });
            }
            setMeetingInfo(
              shouldAllowSpeak
                ? "Microphone access granted by moderator. You can unmute now."
                : "Microphone access revoked by moderator."
            );
            syncLocalControls();
          }
          return;
        }
        if (parsed?.type === "permission_update" && parsed?.permission === "presenter") {
          const targetUserId = Number(parsed?.target_user_id || 0);
          const shouldAllowPresent = Boolean(parsed?.can_present);
          const senderMetadata = parseParticipantMetadata(participant);
          const senderRole = String(senderMetadata?.role || "").trim().toLowerCase();
          const senderIsModerator = Boolean(senderMetadata?.is_admin || senderRole === "instructor");
          if (!senderIsModerator || !Number.isInteger(targetUserId) || targetUserId <= 0) {
            return;
          }
          setPresenterUserIds((previous) => {
            const normalized = normalizeUserIdList(previous);
            if (shouldAllowPresent) {
              return normalizeUserIdList([...normalized, targetUserId]);
            }
            return normalized.filter((value) => value !== targetUserId);
          });
          if (targetUserId === Number(user?.id || 0)) {
            setRuntimeCanPresent(Boolean(shouldAllowPresent || hasPresenterAccess(Number(user?.id || 0))));
            if (!shouldAllowPresent) {
              room.localParticipant
                .setCameraEnabled(false)
                .catch(() => {
                  // best-effort immediate camera stop on revoke
                });
              room.localParticipant
                .setScreenShareEnabled(false)
                .catch(() => {
                  // best-effort immediate screenshare stop on revoke
                });
            }
            setMeetingInfo(
              shouldAllowPresent
                ? "Stage access granted by moderator. Camera and screen share are now available."
                : "Stage access revoked by moderator."
            );
            syncLocalControls();
          }
          return;
        }
        if (parsed.type !== "chat" || !parsed.text) {
          return;
        }
        if (parsed.identity && parsed.identity === meeting.participant_identity) {
          return;
        }
        const senderIdentity = participant?.identity || parsed.identity || "";
        const senderName = participant?.name || parsed.sender || senderIdentity || "Participant";
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            identity: senderIdentity,
            sender: senderName,
            text: parsed.text,
            ts: parsed.ts || new Date().toISOString(),
            isSelf: false,
          },
        ]);
      } catch {
        // ignore non-chat payload
      }
    });

    const connectToRoom = async () => {
      try {
        const connectOptions = connectionStrategy.preferRelayTransport
          ? {
              maxRetries: 6,
              peerConnectionTimeout: 25000,
              websocketTimeout: 20000,
              rtcConfig: { iceTransportPolicy: "relay" },
            }
          : undefined;
        await room.connect(meeting.livekit_url, meeting.token, connectOptions);
        await room.startAudio();
        for (const remoteParticipant of room.remoteParticipants.values()) {
          for (const publication of remoteParticipant.trackPublications.values()) {
            enforceRemotePublicationQuality(publication);
          }
        }
        const canSpeakFromPermissions = extractLocalCanSpeakFromPermissions(room.localParticipant);
        const canPresentFromPermissions = extractLocalCanPresentFromPermissions(room.localParticipant);
        if (typeof canSpeakFromPermissions === "boolean") {
          setRuntimeCanSpeak(Boolean(canSpeakFromPermissions));
        }
        if (typeof canPresentFromPermissions === "boolean") {
          setRuntimeCanPresent(Boolean(canPresentFromPermissions));
        }

        if (effectiveCanPresent) {
          try {
            await enableCameraWithProfile(room.localParticipant, mediaProfile);
          } catch {
            setMeetingInfo("Camera permission not granted.");
          }
          try {
            await room.localParticipant.setMicrophoneEnabled(true);
          } catch {
            setMeetingInfo("Microphone permission not granted.");
          }
        } else if (effectiveCanSpeak) {
          setMeetingInfo(
            "Discussion access enabled. You can use microphone and chat, but camera and screen sharing stay locked unless stage access is granted."
          );
        } else {
          setMeetingInfo("Listener mode enabled. Microphone, camera, and screen sharing are locked until an instructor or admin grants access.");
        }

        if (disposed) {
          return;
        }

        connectedAtRef.current = Date.now();
        setElapsedSeconds(0);
        flushRoomStateRefresh();
        setConnecting(false);
        setConnected(true);
        setConnectionLabel("connected");
        if (canPresentFromPayload) {
          const actualCamera = getLocalCameraCaptureSummary(room.localParticipant);
          setMeetingInfo(
            `Connected. Meeting is live. Camera target: ${mediaProfile.cameraCaptureWidth}x${mediaProfile.cameraCaptureHeight} @ ${mediaProfile.cameraFps}fps / ${mediaProfile.cameraMaxVideoBitrateKbps} kbps.${
              actualCamera
                ? ` Applied capture: ${actualCamera.width}x${actualCamera.height}${
                    actualCamera.fps ? ` @ ${actualCamera.fps}fps` : ""
                  }.`
                : ""
            }${premiumProfileEnabled ? " Premium HD receiver mode enabled." : ""}`
          );
        } else if (canSpeakFromPayload) {
          setMeetingInfo("Connected. Meeting is live. Your microphone is enabled by moderator approval.");
        } else {
          setMeetingInfo(
            connectionStrategy.mobileListener
              ? "Connected. Mobile listener stability mode is enabled."
              : "Connected. Meeting is live. You are in listener mode."
          );
        }
      } catch (err) {
        if (disposed) {
          return;
        }
        setConnecting(false);
        setConnected(false);
        setConnectionLabel("failed");
        setMeetingError(err?.message || "Unable to connect to meeting.");
      }
    };

    connectToRoom();

    return () => {
      disposed = true;
      if (roomStateRefreshTimerRef.current) {
        window.clearTimeout(roomStateRefreshTimerRef.current);
        roomStateRefreshTimerRef.current = null;
      }
      room.removeAllListeners();
      room.disconnect();
      roomRef.current = null;
      connectedAtRef.current = null;
    };
  }, [
    canPresentFromPayload,
    canSpeakFromPayload,
    canManageParticipants,
    connectionStrategy.mobileListener,
    connectionStrategy.preferRelayTransport,
    connectionStrategy.conservativeReceiveProfile,
    enforceRemotePublicationQuality,
    mediaProfile.cameraCaptureHeight,
    mediaProfile.cameraCaptureWidth,
    mediaProfile.cameraFps,
    mediaProfile.cameraMaxVideoBitrateKbps,
    meeting.livekit_url,
    meeting.participant_identity,
    meeting.token,
    premiumProfileEnabled,
    reconnectPolicy,
    syncLocalControls,
    syncParticipants,
    user?.id,
  ]);

  useEffect(() => {
    if (!connected || !connectedAtRef.current) {
      setElapsedSeconds(0);
      return undefined;
    }
    const tick = () => {
      const seconds = Math.max(0, Math.floor((Date.now() - connectedAtRef.current) / 1000));
      setElapsedSeconds(seconds);
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [connected]);

  const participantCount = participants.length;
  const liveDurationLabel = useMemo(() => {
    if (!connectedAtRef.current || !connected) {
      return "";
    }
    const minutes = Math.floor(elapsedSeconds / 60);
    const remainderSeconds = elapsedSeconds % 60;
    return `${minutes.toString().padStart(2, "0")}:${remainderSeconds.toString().padStart(2, "0")}`;
  }, [connected, elapsedSeconds]);

  const participantsOrdered = useMemo(() => {
    const rows = [...participants];
    rows.sort((a, b) => {
      if (a.isLocal && !b.isLocal) return -1;
      if (!a.isLocal && b.isLocal) return 1;
      const aSpeaker = activeSpeakerIds.includes(a.participant.identity) ? 1 : 0;
      const bSpeaker = activeSpeakerIds.includes(b.participant.identity) ? 1 : 0;
      if (aSpeaker !== bSpeaker) return bSpeaker - aSpeaker;
      return participantLabel(a).localeCompare(participantLabel(b));
    });
    return rows;
  }, [activeSpeakerIds, participants]);

  const isModeratorByDefault = useCallback(
    (userId) => Boolean(userId && defaultModeratorUserIds.includes(userId)),
    [defaultModeratorUserIds]
  );
  const elevatedParticipantUserIds = useMemo(
    () =>
      normalizeUserIdList(
        participants
          .filter((entry) => {
            const metadata = entry?.participantMetadata || {};
            return Boolean(metadata?.is_admin || metadata?.role === "instructor");
          })
          .map((entry) => parseUserIdFromIdentity(entry?.participant?.identity))
      ),
    [participants]
  );
  const hasCoreModeratorAccess = useCallback(
    (userId) => Boolean(userId && (isModeratorByDefault(userId) || elevatedParticipantUserIds.includes(userId))),
    [elevatedParticipantUserIds, isModeratorByDefault]
  );
  const hasPresenterAccess = useCallback(
    (userId) =>
      Boolean(
        userId &&
          (hasCoreModeratorAccess(userId) || presenterUserIds.includes(userId))
      ),
    [hasCoreModeratorAccess, presenterUserIds]
  );
  const hasSpeakerAccess = useCallback(
    (userId) =>
      Boolean(
        userId &&
          (hasCoreModeratorAccess(userId) || speakerUserIds.includes(userId))
      ),
    [hasCoreModeratorAccess, speakerUserIds]
  );
  const stageParticipants = useMemo(
    () =>
      participantsOrdered.filter((entry) => {
        const participantUserId = parseUserIdFromIdentity(entry?.participant?.identity);
        return hasPresenterAccess(participantUserId);
      }),
    [hasPresenterAccess, participantsOrdered]
  );
  const featuredParticipant = useMemo(() => {
    if (pinnedIdentity) {
      return stageParticipants.find((entry) => entry.participant.identity === pinnedIdentity) || null;
    }
    const screenshareOwner = stageParticipants.find((entry) => getParticipantMediaState(entry.participant).hasScreenShare);
    if (screenshareOwner) {
      return screenshareOwner;
    }
    const activeSpeaker = stageParticipants.find((entry) =>
      activeSpeakerIds.includes(entry.participant.identity)
    );
    return activeSpeaker || stageParticipants[0] || null;
  }, [activeSpeakerIds, pinnedIdentity, stageParticipants]);
  const otherParticipants = useMemo(() => {
    if (!featuredParticipant) {
      return [];
    }
    return stageParticipants.filter((entry) => entry.id !== featuredParticipant.id);
  }, [featuredParticipant, stageParticipants]);
  const featuredHasScreenShare = featuredParticipant
    ? getParticipantMediaState(featuredParticipant.participant).hasScreenShare
    : false;
  const useFeaturedLayout = Boolean(featuredParticipant) && (otherParticipants.length > 0 || featuredHasScreenShare);
  const stagePriorityMode = audienceFocusMode && !sidePanelOpen;
  const shareableJoinLink = buildJoinLink(session);
  const localUserId = Number(user?.id) || null;
  const effectiveCanPresent = Boolean(runtimeCanPresent || hasPresenterAccess(localUserId));
  const effectiveCanSpeak = Boolean(runtimeCanSpeak || hasSpeakerAccess(localUserId));
  const stageSlotsUsed = presenterUserIds.length;
  const moderationSummary = useMemo(
    () => ({
      micGrants: speakerUserIds.filter((userId) => !hasCoreModeratorAccess(userId)).length,
      stageUsed: stageSlotsUsed,
      stageRemaining: Math.max(0, MAX_STAGE_PARTICIPANTS - stageSlotsUsed),
    }),
    [hasCoreModeratorAccess, speakerUserIds, stageSlotsUsed]
  );

  const toggleStageFullscreen = async () => {
    const element = stageRef.current;
    if (!element) {
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await element.requestFullscreen();
      }
    } catch {
      setMeetingError("Unable to toggle fullscreen mode.");
    }
  };

  const handleCopyJoinLink = async () => {
    if (!shareableJoinLink) {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareableJoinLink);
      setMeetingInfo("Join link copied.");
    } catch {
      setMeetingError("Unable to copy join link.");
    }
  };

  const handleCopyBroadcastChatLink = async () => {
    if (!broadcastChatUrl) {
      setMeetingError("Broadcast chat URL is not configured for this session.");
      return;
    }
    try {
      await navigator.clipboard.writeText(broadcastChatUrl);
      setMeetingInfo("Broadcast chat link copied.");
    } catch {
      setMeetingError("Unable to copy broadcast chat link.");
    }
  };

  const handleOpenBroadcastChat = () => {
    if (!broadcastChatUrl) {
      setMeetingError("Broadcast chat URL is not configured for this session.");
      return;
    }
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) {
      setMeetingError("Popup blocked by browser. Allow popups and use 'Copy Chat' if needed.");
      return;
    }
    const loadingMarkup =
      "<!doctype html><html><body style='margin:0;background:#0b0f19;color:#d8dbe3;font-family:system-ui,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;'><div>Preparing broadcast chat...</div></body></html>";
    popup.document.write(loadingMarkup);
    popup.document.close();

    (async () => {
      let launchUrl = broadcastChatUrl;
      let usedFallback = false;
      if (session?.id) {
        try {
          const launchResponse = await createRealtimeOwncastChatLaunch(session.id);
          const launchData = apiData(launchResponse, {});
          const candidate = String(launchData?.launch_url || "").trim();
          if (candidate) {
            launchUrl = candidate;
          }
        } catch (err) {
          usedFallback = true;
          setMeetingError(
            `${apiMessage(err, "Unable to prepare personalized chat launch.")} Opened default chat link instead.`
          );
        }
      }
      popup.location.replace(launchUrl);
      if (!usedFallback) {
        setMeetingInfo("Broadcast chat opened in a new tab.");
      }
    })();
  };

  const runControlAction = async (
    operation,
    fallbackError,
    permissionRequirement = "present",
    options = {}
  ) => {
    const {
      requiresMediaApi = false,
      featureName = "microphone",
      shouldValidateMediaApi = null,
    } = options;
    if (permissionRequirement === "speak" && !effectiveCanSpeak) {
      setMeetingError("Microphone access is disabled for your role in this meeting.");
      return;
    }
    if (permissionRequirement === "present" && !effectiveCanPresent) {
      setMeetingError("Presenter access is required for camera and screen share.");
      return;
    }
    const room = roomRef.current;
    if (!room?.localParticipant) {
      return;
    }

    const shouldCheckMediaApi =
      requiresMediaApi &&
      (typeof shouldValidateMediaApi === "function" ? shouldValidateMediaApi() : true);
    if (shouldCheckMediaApi && !hasMediaCaptureApi()) {
      setMeetingError(mediaPermissionHelpMessage(featureName));
      return;
    }

    setControlBusy(true);
    setMeetingError("");
    try {
      await operation(room.localParticipant);
      syncLocalControls();
    } catch (err) {
      setMeetingError(resolveControlError(err, fallbackError, featureName));
    } finally {
      setControlBusy(false);
    }
  };

  const publishPermissionControlMessage = async (payload) => {
    const room = roomRef.current;
    if (!room?.localParticipant) {
      return;
    }
    try {
      await room.localParticipant.publishData(textEncoder.encode(JSON.stringify(payload)), {
        reliable: true,
        topic: "meeting-control",
      });
    } catch {
      // Best effort. Backend already persists + applies LiveKit permissions directly.
    }
  };

  const toggleMicrophone = () =>
    runControlAction(
      (localParticipant) => localParticipant.setMicrophoneEnabled(!controls.mic),
      "Unable to update microphone.",
      "speak",
      {
        requiresMediaApi: true,
        featureName: "Microphone",
        shouldValidateMediaApi: () => !controls.mic,
      }
    );

  const toggleCamera = () =>
    runControlAction(
      async (localParticipant) => {
        if (controls.camera) {
          await localParticipant.setCameraEnabled(false);
          return;
        }
        await enableCameraWithProfile(localParticipant, mediaProfile);
        const actualCamera = getLocalCameraCaptureSummary(localParticipant);
        if (actualCamera) {
          setMeetingInfo(
            `Camera updated: ${actualCamera.width}x${actualCamera.height}${
              actualCamera.fps ? ` @ ${actualCamera.fps}fps` : ""
            }.`
          );
        }
      },
      "Unable to update camera.",
      "present",
      {
        requiresMediaApi: true,
        featureName: "Camera",
        shouldValidateMediaApi: () => !controls.camera,
      }
    );

  const toggleScreenShare = () =>
    runControlAction(
      (localParticipant) => {
        if (controls.screen) {
          return localParticipant.setScreenShareEnabled(false);
        }
        return enableScreenShareWithProfile(localParticipant, mediaProfile);
      },
      "Unable to update screen sharing.",
      "present",
      {
        requiresMediaApi: true,
        featureName: "Screen share",
        shouldValidateMediaApi: () => !controls.screen,
      }
    );

  const handleSpeakerPermission = async (userId, grantAccess) => {
    if (!canManageParticipants || !session.id || !userId) {
      return;
    }
    if (hasCoreModeratorAccess(userId)) {
      setPermissionState({
        loadingKey: "",
        error: "",
        info: "Host/instructor access is role-protected and cannot be changed from this panel.",
      });
      return;
    }
    setPermissionState({ loadingKey: `speaker:${userId}`, error: "", info: "" });
    try {
      const response = grantAccess
        ? await grantRealtimeSpeaker(session.id, userId)
        : await revokeRealtimeSpeaker(session.id, userId);
      const data = apiData(response, {});
      setPresenterUserIds(normalizeUserIdList(data.presenter_user_ids));
      setSpeakerUserIds(normalizeUserIdList(data.speaker_user_ids));
      await publishPermissionControlMessage({
        type: "permission_update",
        permission: "speaker",
        target_user_id: Number(userId),
        can_speak: Boolean(grantAccess),
        ts: new Date().toISOString(),
      });
      setPermissionState({
        loadingKey: "",
        error: "",
        info: `${grantAccess ? "Mic access granted" : "Mic access revoked"} for user ${userId}. ${
          String(data.note || "").trim() || "Applied live for connected participants."
        }`,
      });
    } catch (err) {
      setPermissionState({
        loadingKey: "",
        error: apiMessage(err, "Unable to update microphone permission."),
        info: "",
      });
    }
  };

  const handlePresenterPermission = async (userId, grantAccess) => {
    if (!canManageParticipants || !session.id || !userId) {
      return;
    }
    if (hasCoreModeratorAccess(userId)) {
      setPermissionState({
        loadingKey: "",
        error: "",
        info: "Host/instructor access is role-protected and cannot be changed from this panel.",
      });
      return;
    }
    if (grantAccess && !presenterUserIds.includes(userId) && stageSlotsUsed >= MAX_STAGE_PARTICIPANTS) {
      setPermissionState({
        loadingKey: "",
        error: `Stage limit reached (${MAX_STAGE_PARTICIPANTS}). Remove someone from stage first.`,
        info: "",
      });
      return;
    }
    setPermissionState({ loadingKey: `presenter:${userId}`, error: "", info: "" });
    try {
      const response = grantAccess
        ? await grantRealtimePresenter(session.id, userId)
        : await revokeRealtimePresenter(session.id, userId);
      const data = apiData(response, {});
      setPresenterUserIds(normalizeUserIdList(data.presenter_user_ids));
      setSpeakerUserIds(normalizeUserIdList(data.speaker_user_ids));
      await publishPermissionControlMessage({
        type: "permission_update",
        permission: "presenter",
        target_user_id: Number(userId),
        can_present: Boolean(grantAccess),
        ts: new Date().toISOString(),
      });
      setPermissionState({
        loadingKey: "",
        error: "",
        info: `${grantAccess ? "Stage access granted" : "Stage access revoked"} for user ${userId}. ${
          String(data.note || "").trim() || "Applied live for connected participants."
        }`,
      });
    } catch (err) {
      setPermissionState({
        loadingKey: "",
        error: apiMessage(err, "Unable to update stage permission."),
        info: "",
      });
    }
  };

  const handleStartRecording = async () => {
    if (!session.id || !canManageParticipants) {
      return;
    }
    setRecordingState((prev) => ({ ...prev, loading: true, error: "", info: "" }));
    try {
      const response = await startRealtimeRecording(session.id);
      const recording = apiData(response, null);
      setRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: "",
        info: "Recording started.",
        active: recording,
        mode: resolveRecordingMode(recording) || "livekit-egress",
      }));
    } catch (livekitErr) {
      try {
        const fallbackRecorder =
          fallbackRecorderRef.current || new ScreenityFallbackRecorder({ withMicrophone: true });
        fallbackRecorderRef.current = fallbackRecorder;
        if (!fallbackRecorder.isRecording) {
          await fallbackRecorder.start();
        }
        setRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "",
          info: "LiveKit recorder unavailable. Browser fallback recording started.",
          active: {
            id: "browser-fallback",
            status: "recording",
            is_active: true,
            source: "browser_fallback",
          },
          mode: "screenity-fallback",
        }));
      } catch (fallbackErr) {
        fallbackRecorderRef.current = null;
        const primaryError = apiMessage(livekitErr, "Unable to start recording.");
        const fallbackError = resolveControlError(
          fallbackErr,
          "Browser fallback recording failed.",
          "Screen recording"
        );
        setRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: `${primaryError} ${fallbackError}`,
          info: "",
          mode: "",
        }));
      }
    }
  };

  const handleStopRecording = async () => {
    if (!session.id || !canManageParticipants) {
      return;
    }
    setRecordingState((prev) => ({ ...prev, loading: true, error: "", info: "" }));
    if (recordingState.mode === "screenity-fallback") {
      const fallbackRecorder = fallbackRecorderRef.current;
      if (!fallbackRecorder || !fallbackRecorder.isRecording) {
        setRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "No active fallback recording found.",
          info: "",
          active: null,
          mode: "",
        }));
        return;
      }
      try {
        const localRecording = await fallbackRecorder.stop();
        fallbackRecorderRef.current = null;

        const formData = new FormData();
        formData.append("video_file", localRecording.file, localRecording.file_name);
        if (localRecording.started_at) {
          formData.append("started_at", localRecording.started_at);
        }
        if (localRecording.ended_at) {
          formData.append("ended_at", localRecording.ended_at);
        }

        const uploadResponse = await uploadRealtimeBrowserRecording(session.id, formData);
        const storedRecording = apiData(uploadResponse, null);
        setRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: "",
          info: "Fallback recording uploaded and stored.",
          active: null,
          latestCompleted: storedRecording || prev.latestCompleted,
          mode: "",
        }));
      } catch (err) {
        setRecordingState((prev) => ({
          ...prev,
          loading: false,
          error: resolveControlError(err, "Unable to stop/upload fallback recording.", "Screen recording"),
          info: "",
        }));
      }
      return;
    }

    try {
      const response = await stopRealtimeRecording(session.id);
      const recording = apiData(response, null);
      setRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: "",
        info: "Recording stopped and stored.",
        active: recording?.is_active ? recording : null,
        latestCompleted: recording?.status === "completed" ? recording : prev.latestCompleted,
        mode: recording?.is_active ? resolveRecordingMode(recording) : "",
      }));
    } catch (err) {
      setRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: apiMessage(err, "Unable to stop recording."),
        info: "",
      }));
    }
  };

  const handleDeleteLatestRecording = async () => {
    if (!session.id || !canManageParticipants) {
      return;
    }
    const latest = recordingState.latestCompleted;
    if (!latest?.id) {
      return;
    }
    if (!window.confirm("Delete the latest recording permanently? This cannot be undone.")) {
      return;
    }
    setRecordingState((prev) => ({ ...prev, loading: true, error: "", info: "" }));
    try {
      await deleteRealtimeRecording(latest.id);
      setRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: "",
        info: "Latest recording deleted.",
        active: prev.active?.id === latest.id ? null : prev.active,
        latestCompleted: prev.latestCompleted?.id === latest.id ? null : prev.latestCompleted,
      }));
    } catch (err) {
      setRecordingState((prev) => ({
        ...prev,
        loading: false,
        error: apiMessage(err, "Unable to delete recording."),
        info: "",
      }));
    }
  };

  const handleLeaveMeeting = () => {
    const fallbackRecorder = fallbackRecorderRef.current;
    if (fallbackRecorder?.isRecording) {
      fallbackRecorder.stop().catch(() => {
        // best-effort cleanup on leave
      });
    }
    fallbackRecorderRef.current = null;
    const room = roomRef.current;
    if (room) {
      room.disconnect();
    }
    setConnected(false);
    setConnecting(false);
    setConnectionLabel("left");
    setMeetingInfo("You left the meeting.");
    if (onLeave) {
      onLeave();
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    const text = chatInput.trim();
    if (!text) {
      return;
    }

    const room = roomRef.current;
    if (!room?.localParticipant) {
      setMeetingError("Meeting chat is unavailable.");
      return;
    }

    const message = {
      id: `${Date.now()}-${Math.random()}`,
      type: "chat",
      text,
      ts: new Date().toISOString(),
      sender: meeting.participant_name || "You",
      identity: meeting.participant_identity || "local",
    };

    setMessages((prev) => [...prev, { ...message, isSelf: true }]);
    setChatInput("");

    try {
      await room.localParticipant.publishData(textEncoder.encode(JSON.stringify(message)), {
        reliable: true,
        topic: "meeting-chat",
      });
      setMeetingError("");
      return;
    } catch {
      // Some LiveKit server/client version mixes reject topic-based payloads.
      // Retry without topic so chat remains functional.
    }

    try {
      await room.localParticipant.publishData(textEncoder.encode(JSON.stringify(message)), {
        reliable: true,
      });
      setMeetingError("");
    } catch {
      setMeetingError("Unable to send message.");
    }
  };

  const connectionStatusLabel = humanizeConnectionLabel(connectionLabel);
  const connectionStatusToneClass = (() => {
    const normalized = String(connectionLabel || "").toLowerCase();
    if (normalized.includes("reconnect")) {
      return "border-amber-200/20 bg-amber-100/8 text-amber-100";
    }
    if (normalized.includes("connect")) {
      return "border-[#C0C0C0]/30 bg-[#C0C0C0]/14 text-[#F1F1F1]";
    }
    if (normalized.includes("fail") || normalized.includes("left") || normalized.includes("disconnect")) {
      return "border-red-300/25 bg-red-300/10 text-red-100";
    }
    return "border-black bg-[#161616]/80 text-[#E1E1E1]";
  })();
  const viewerRoleLabel = canManageParticipants
    ? "Moderator"
    : effectiveCanPresent
      ? "Presenter"
      : effectiveCanSpeak
        ? "Speaker"
        : "Listener";
  const latestRecordingPlaybackUrl = resolveRecordingPlaybackUrl(recordingState.latestCompleted);

  return (
    <section
      className="relative mb-6 overflow-hidden rounded-[32px] border border-black panel-gradient shadow-[0_32px_80px_rgba(0,0,0,0.36)]"
    >
      <div className="absolute inset-0">
        <img
          src={meetingShellBackgroundImage}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-cover opacity-[0.12] blur-[1px] grayscale"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/66 via-black/78 to-black/88" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(192,192,192,0.12),transparent_34%)]" />
      </div>

      <div className="relative border-b border-black bg-[linear-gradient(180deg,rgba(12,12,12,0.84),rgba(16,16,16,0.78))] px-4 py-4 backdrop-blur-[2px] sm:px-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]">
              <span className="rounded-full border border-black bg-[#141414]/82 px-3 py-1 text-[#E1E1E1]">
                Meeting room
              </span>
              <span className={`rounded-full border px-3 py-1 ${connectionStatusToneClass}`}>
                {connectionStatusLabel}
              </span>
              <span className="rounded-full border border-black bg-[#141414]/82 px-3 py-1 text-[#E1E1E1]">
                {viewerRoleLabel}
              </span>
            </div>
            <h3 className="mt-3 font-reference text-2xl font-semibold tracking-tight text-white">
              {session.title || "Meeting Room"}
            </h3>
            <p className="mt-1 text-sm text-[#BBBBBB]">
              Room {meeting.room_name || "-"} with live stage, audience controls, and in-session chat.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-black bg-[#141414]/86 px-3 py-1.5 text-xs text-[#E1E1E1]">
                {participantCount} participant{participantCount === 1 ? "" : "s"}
              </span>
              <span className="rounded-full border border-black bg-[#141414]/86 px-3 py-1.5 text-xs text-[#E1E1E1]">
                {liveDurationLabel || "--:--"}
              </span>
              <span className="rounded-full border border-black bg-[#141414]/86 px-3 py-1.5 text-xs text-[#E1E1E1]">
                {sidePanelOpen ? `${panelTab === "people" ? "People" : "Chat"} panel open` : "Stage focus"}
              </span>
            </div>
          </div>

	          <div className="grid gap-3 sm:min-w-[340px] sm:grid-cols-[minmax(0,1fr)_auto]">
	            <div className="rounded-[22px] border border-black panel-gradient px-4 py-3 backdrop-blur-sm">
	              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
	                Share link
	              </div>
	              <code className="mt-2 block truncate rounded-xl bg-[#101010] px-3 py-2 text-xs text-[#E1E1E1]">
	                {shareableJoinLink || "Join link unavailable"}
	              </code>
	            </div>
              {isBroadcastControlSession ? (
                <div className="overflow-hidden rounded-[22px] border border-black panel-gradient backdrop-blur-sm sm:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black px-4 py-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
                      Broadcast monitor
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        variant="secondary"
                        className="rounded-full border-black bg-[#141414]/92 px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-[#DBDBDB] shadow-none hover:bg-[#1B1B1B]"
                        onClick={handleOpenBroadcastChat}
                        disabled={!broadcastChatUrl}
                      >
                        Open Broadcast Chat
                      </Button>
                      <Button
                        variant="secondary"
                        className="rounded-full border-black bg-[#141414]/92 px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-[#DBDBDB] shadow-none hover:bg-[#1B1B1B]"
                        onClick={handleCopyBroadcastChatLink}
                        disabled={!broadcastChatUrl}
                      >
                        Copy Chat
                      </Button>
                    </div>
                  </div>
                  {broadcastMonitorUrl ? (
                    <iframe
                      title="Broadcast Live Output"
                      src={broadcastMonitorUrl}
                      className="h-[170px] w-full sm:h-[210px]"
                      allow="autoplay; fullscreen"
                    />
                  ) : (
                    <div className="flex h-[170px] items-center justify-center px-4 text-center text-xs text-[#BBBBBB] sm:h-[210px]">
                      Live broadcast output appears here once stream publishing starts.
                    </div>
                  )}
                </div>
              ) : null}
	            <div className="flex flex-col gap-2">
	              <Button
	                variant="secondary"
	                className="rounded-full border-black bg-[#141414]/92 px-4 py-2 text-[#DBDBDB] shadow-none hover:bg-[#1B1B1B]"
	                onClick={handleCopyJoinLink}
              >
                Copy link
              </Button>
              <Button
                variant="secondary"
                className="rounded-full border-black bg-[#141414]/92 px-4 py-2 text-[#DBDBDB] shadow-none hover:bg-[#1B1B1B]"
                onClick={() => setSidePanelOpen((prev) => !prev)}
              >
                {sidePanelOpen ? "Hide panel" : "Open panel"}
              </Button>
              <Button
                variant="secondary"
                className="rounded-full border-black bg-[#141414]/92 px-4 py-2 text-[#DBDBDB] shadow-none hover:bg-[#1B1B1B]"
                onClick={toggleStageFullscreen}
              >
                {isStageFullscreen ? "Exit fullscreen" : "Fullscreen"}
              </Button>
            </div>
          </div>
        </div>

        {canManageParticipants ? (
          <div className="mt-4 rounded-[26px] border border-black panel-gradient p-4 backdrop-blur-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-2xl">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                  Seminar control
                </div>
                <div className="mt-2 text-base font-semibold text-white">
                  Build a live stage by promoting up to 5 participants and controlling microphone access separately.
                </div>
                <p className="mt-1 text-sm text-[#BBBBBB]">
                  Host/instructor roles always keep full control. Stage participants can be added or removed instantly without forcing rejoin.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-[20px] border border-black panel-gradient px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
                    Stage slots used
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">{moderationSummary.stageUsed}</div>
                </div>
                <div className="rounded-[20px] border border-black panel-gradient px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
                    Mic grants
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">{moderationSummary.micGrants}</div>
                </div>
                <div className="rounded-[20px] border border-black panel-gradient px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
                    Stage slots left
                  </div>
                  <div className="mt-2 text-2xl font-semibold text-white">{moderationSummary.stageRemaining}</div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-black bg-[#101010] px-3 py-1.5 text-xs text-[#E1E1E1]">
                Recording: {recordingState.active?.status || "idle"}
                {recordingState.active
                  ? ` (${recordingState.mode === "screenity-fallback" ? "browser fallback" : "livekit"})`
                  : ""}
              </span>
              <Button
                className="rounded-full border border-[#D7D7D7] bg-gradient-to-r from-[#DADADA] to-[#AFAFAF] px-4 py-2 text-[#121212] shadow-none hover:from-[#E5E5E5] hover:to-[#C0C0C0]"
                onClick={handleStartRecording}
                loading={recordingState.loading}
                disabled={Boolean(recordingState.active)}
              >
                Start recording
              </Button>
              <Button
                variant="danger"
                className="rounded-full border-[#A9A9A9] bg-[#737373] px-4 py-2 text-white shadow-none hover:bg-[#616161]"
                onClick={handleStopRecording}
                loading={recordingState.loading}
                disabled={!recordingState.active}
              >
                Stop recording
              </Button>
              {latestRecordingPlaybackUrl ? (
                <a
                  href={latestRecordingPlaybackUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-black bg-[#141414]/92 px-4 py-2 text-sm font-semibold text-[#DBDBDB] transition hover:bg-[#1B1B1B]"
                >
                  Open last recording
                </a>
              ) : null}
              <Button
                variant="danger"
                className="rounded-full border-red-400/40 bg-red-600 px-4 py-2 text-white shadow-none hover:bg-red-500"
                onClick={handleDeleteLatestRecording}
                loading={recordingState.loading}
                disabled={!recordingState.latestCompleted?.id || Boolean(recordingState.active)}
              >
                Delete last recording
              </Button>
            </div>
            {recordingState.error ? <p className="mt-3 text-xs text-[#A9A9A9]">{recordingState.error}</p> : null}
            {recordingState.info ? <p className="mt-3 text-xs text-[#C7C7C7]">{recordingState.info}</p> : null}
          </div>
        ) : null}
      </div>

      <div className={sidePanelOpen ? "grid gap-0 xl:grid-cols-[minmax(0,1fr)_360px]" : "grid gap-0"}>
        <div
          ref={stageRef}
          className={`${
            stagePriorityMode
              ? "min-h-[58vh] sm:min-h-[66vh] lg:min-h-[74vh]"
              : "min-h-[340px] sm:min-h-[460px] lg:min-h-[520px]"
          } bg-[linear-gradient(180deg,rgba(10,10,10,0.26),rgba(10,10,10,0.12))] p-4 sm:p-5`}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#949494]">Stage</div>
              <div className="mt-1 text-sm text-[#E1E1E1]">
                {featuredParticipant
                  ? `${participantLabel(featuredParticipant)} is currently featured.`
                  : "Waiting for participants to join the stage."}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {pinnedIdentity ? (
                <span className="rounded-full border border-black bg-[#141414]/86 px-3 py-1.5 text-xs text-[#E1E1E1]">
                  Pinned view active
                </span>
              ) : null}
              {audienceFocusMode ? (
                <span className="rounded-full border border-black bg-[#141414]/86 px-3 py-1.5 text-xs text-[#E1E1E1]">
                  Audience focus mode
                </span>
              ) : null}
            </div>
          </div>
          {connecting ? (
            <div className="flex h-[220px] items-center justify-center rounded-[28px] border border-black panel-gradient text-[#E1E1E1] sm:h-[320px] lg:h-[460px]">
              Connecting to meeting...
            </div>
          ) : useFeaturedLayout ? (
            otherParticipants.length > 0 ? (
              stagePriorityMode ? (
                <div className="space-y-3">
                  <MemoMeetingTile
                    key={featuredParticipant.id}
                    entry={featuredParticipant}
                    isFeatured
                    isPinned={pinnedIdentity === featuredParticipant.participant.identity}
                    isSpeaking={activeSpeakerIds.includes(featuredParticipant.participant.identity)}
                    onPin={() =>
                      setPinnedIdentity((prev) =>
                        prev === featuredParticipant.participant.identity
                          ? ""
                          : featuredParticipant.participant.identity
                      )
                    }
                  />
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {otherParticipants.map((entry) => (
                      <div key={entry.id} className="min-w-[220px] max-w-[260px] flex-none">
                        <MemoMeetingTile
                          entry={entry}
                          isPinned={pinnedIdentity === entry.participant.identity}
                          isSpeaking={activeSpeakerIds.includes(entry.participant.identity)}
                          onPin={() =>
                            setPinnedIdentity((prev) =>
                              prev === entry.participant.identity ? "" : entry.participant.identity
                            )
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div
                  className={`grid gap-3 ${
                    featuredHasScreenShare ? "xl:grid-cols-[minmax(0,1fr)_280px]" : "lg:grid-cols-[1fr_240px]"
                  }`}
                >
                  <MemoMeetingTile
                    key={featuredParticipant.id}
                    entry={featuredParticipant}
                    isFeatured
                    isPinned={pinnedIdentity === featuredParticipant.participant.identity}
                    isSpeaking={activeSpeakerIds.includes(featuredParticipant.participant.identity)}
                    onPin={() =>
                      setPinnedIdentity((prev) =>
                        prev === featuredParticipant.participant.identity
                          ? ""
                          : featuredParticipant.participant.identity
                      )
                    }
                  />
                  <div
                    className={`${
                      featuredHasScreenShare
                        ? "max-h-[260px] sm:max-h-[360px] lg:max-h-[560px]"
                        : "max-h-[220px] sm:max-h-[320px] lg:max-h-[420px]"
                    } space-y-3 overflow-y-auto pr-1`}
                  >
                    {otherParticipants.map((entry) => (
                      <MemoMeetingTile
                        key={entry.id}
                        entry={entry}
                        isPinned={pinnedIdentity === entry.participant.identity}
                        isSpeaking={activeSpeakerIds.includes(entry.participant.identity)}
                        onPin={() =>
                          setPinnedIdentity((prev) =>
                            prev === entry.participant.identity ? "" : entry.participant.identity
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              )
            ) : (
              <MemoMeetingTile
                key={featuredParticipant.id}
                entry={featuredParticipant}
                isFeatured
                isPinned={pinnedIdentity === featuredParticipant.participant.identity}
                isSpeaking={activeSpeakerIds.includes(featuredParticipant.participant.identity)}
                onPin={() =>
                  setPinnedIdentity((prev) =>
                    prev === featuredParticipant.participant.identity ? "" : featuredParticipant.participant.identity
                  )
                }
              />
            )
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {stageParticipants.map((entry) => (
                <MemoMeetingTile
                  key={entry.id}
                  entry={entry}
                  isPinned={pinnedIdentity === entry.participant.identity}
                  isSpeaking={activeSpeakerIds.includes(entry.participant.identity)}
                  onPin={() =>
                    setPinnedIdentity((prev) =>
                      prev === entry.participant.identity ? "" : entry.participant.identity
                    )
                  }
                />
              ))}
            </div>
          )}

          {meetingError ? (
            <div className="mt-4 rounded-2xl border border-[#737373]/35 bg-[#737373]/10 px-4 py-3 text-sm text-[#E4E4E4]">
              {meetingError}
            </div>
          ) : null}
          {meetingInfo ? (
            <div className="mt-4 rounded-2xl border border-black panel-gradient px-4 py-3 text-sm text-[#E1E1E1]">
              {meetingInfo}
            </div>
          ) : null}
          {permissionState.error ? (
            <div className="mt-4 rounded-2xl border border-[#737373]/35 bg-[#737373]/10 px-4 py-3 text-sm text-[#E4E4E4]">
              {permissionState.error}
            </div>
          ) : null}
          {permissionState.info ? (
            <div className="mt-4 rounded-2xl border border-black panel-gradient px-4 py-3 text-sm text-[#E1E1E1]">
              {permissionState.info}
            </div>
          ) : null}
        </div>

        {sidePanelOpen ? (
          <aside className="border-t border-black bg-[#131313]/84 backdrop-blur-sm xl:border-l xl:border-t-0">
            <div className="border-b border-black px-4 py-3">
              <div className="rounded-full panel-gradient p-1">
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    className={`rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                      panelTab === "people"
                        ? "bg-gradient-to-r from-[#DADADA] to-[#AFAFAF] text-[#121212]"
                        : "text-[#949494] hover:bg-[#1B1B1B]"
                    }`}
                    onClick={() => setPanelTab("people")}
                  >
                    {canManageParticipants ? "People + control" : "People"}
                  </button>
                  <button
                    type="button"
                    className={`rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                      panelTab === "chat"
                        ? "bg-gradient-to-r from-[#DADADA] to-[#AFAFAF] text-[#121212]"
                        : "text-[#949494] hover:bg-[#1B1B1B]"
                    }`}
                    onClick={() => setPanelTab("chat")}
                  >
                    Chat
                  </button>
                </div>
              </div>
            </div>

          {panelTab === "people" ? (
            <div className="max-h-[320px] overflow-y-auto p-3 sm:max-h-[420px] xl:h-[520px] xl:max-h-none xl:p-4">
              <div className="mb-3 flex items-center justify-between gap-2 px-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8E8E8E]">
                  Participants + stage
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="rounded-full border border-black bg-[#151515] px-2.5 py-1 text-[11px] text-[#E1E1E1]">
                    {participantCount}
                  </span>
                  <span className="rounded-full border border-black bg-[#151515] px-2.5 py-1 text-[11px] text-[#E1E1E1]">
                    Stage {stageSlotsUsed}/{MAX_STAGE_PARTICIPANTS}
                  </span>
                </div>
              </div>
              <div className="space-y-2.5">
                {participantsOrdered.map((entry) => {
                  const media = getParticipantMediaState(entry.participant);
                  const participantUserId = parseUserIdFromIdentity(entry.participant.identity);
                  const coreModeratorAccess = hasCoreModeratorAccess(participantUserId);
                  const presenterAccessEnabled = hasPresenterAccess(participantUserId);
                  const speakerAccessEnabled = hasSpeakerAccess(participantUserId);
                  const loadingPresenter = permissionState.loadingKey === `presenter:${participantUserId}`;
                  const loadingSpeaker = permissionState.loadingKey === `speaker:${participantUserId}`;
                  const canGrantStage = !presenterAccessEnabled && stageSlotsUsed < MAX_STAGE_PARTICIPANTS;
                  const participantAvatarUrl = String(entry?.profileImageUrl || "").trim();
                  const mediaSummary = `${media.hasCamera ? "Camera on" : "Camera off"} | ${
                    media.hasAudio ? "Mic on" : "Mic off"
                  }${media.hasScreenShare ? " | Presenting" : ""}`;
                  const accessModeLabel = presenterAccessEnabled
                    ? "Stage"
                    : speakerAccessEnabled
                      ? "Mic enabled"
                      : "Listener";
                  const roleBadges = [
                    coreModeratorAccess ? "Host / Instructor" : "",
                    presenterAccessEnabled ? "Stage" : "",
                    speakerAccessEnabled && !presenterAccessEnabled ? "Mic" : "",
                    !speakerAccessEnabled ? "Listener" : "",
                  ].filter(Boolean);
                  return (
                    <div
                      key={entry.id}
                      className="rounded-[18px] border border-black bg-[#111111]/95 px-3 py-3 text-sm text-[#E1E1E1] shadow-[0_10px_18px_rgba(0,0,0,0.22)]"
                    >
                      <div className="flex items-start gap-2.5">
                        {participantAvatarUrl ? (
                          <img
                            src={participantAvatarUrl}
                            alt={participantLabel(entry)}
                            className="h-10 w-10 flex-none rounded-full border border-black object-cover"
                          />
                        ) : (
                          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[#252525] text-sm font-semibold text-white">
                            {participantInitials(participantLabel(entry))}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-[15px] font-semibold text-white">
                                {participantLabel(entry)}
                              </div>
                              <div className="mt-0.5 text-[11px] text-[#AFAFAF]">{mediaSummary}</div>
                            </div>
                            <div className="rounded-full border border-black bg-[#171717] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#D9D9D9]">
                              {accessModeLabel}
                            </div>
                          </div>

                          {roleBadges.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {roleBadges.map((badge) => (
                                <span
                                  key={`${entry.id}-${badge}`}
                                  className="rounded-full border border-black bg-[#151515] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#CFCFCF]"
                                >
                                  {badge}
                                </span>
                              ))}
                            </div>
                          ) : null}

                          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
                            <div className="rounded-xl border border-black bg-[#161616] px-2.5 py-2">
                              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#8F8F8F]">
                                Microphone
                              </div>
                              <div
                                className={`mt-1 text-xs font-semibold ${
                                  speakerAccessEnabled ? "text-[#ECECEC]" : "text-[#AFAFAF]"
                                }`}
                              >
                                {speakerAccessEnabled ? "Allowed" : "Locked"}
                              </div>
                            </div>
                            <div className="rounded-xl border border-black bg-[#161616] px-2.5 py-2">
                              <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#8F8F8F]">
                                Camera / screen
                              </div>
                              <div
                                className={`mt-1 text-xs font-semibold ${
                                  presenterAccessEnabled ? "text-[#ECECEC]" : "text-[#AFAFAF]"
                                }`}
                              >
                                {presenterAccessEnabled ? "Allowed" : "Locked"}
                              </div>
                            </div>
                          </div>

                          {canManageParticipants && participantUserId && !entry.isLocal ? (
                            <div className="mt-2.5">
                              {!coreModeratorAccess ? (
                                <div className="grid gap-2 sm:grid-cols-2">
                                  <Button
                                    variant={presenterAccessEnabled ? "danger" : "secondary"}
                                    className={`w-full rounded-full px-3 py-2 text-[11px] shadow-none ${
                                      presenterAccessEnabled
                                        ? "border-[#A9A9A9] bg-[#737373] text-white hover:bg-[#616161]"
                                        : "border-black bg-[#1A1A1A] text-[#DADADA] hover:bg-[#222222]"
                                    }`}
                                    loading={loadingPresenter}
                                    disabled={!presenterAccessEnabled && !canGrantStage}
                                    onClick={() => handlePresenterPermission(participantUserId, !presenterAccessEnabled)}
                                  >
                                    {presenterAccessEnabled ? "Remove stage" : "Add to stage"}
                                  </Button>
                                  <Button
                                    variant={speakerAccessEnabled ? "danger" : "secondary"}
                                    className={`w-full rounded-full px-3 py-2 text-[11px] shadow-none ${
                                      speakerAccessEnabled
                                        ? "border-[#A9A9A9] bg-[#737373] text-white hover:bg-[#616161]"
                                        : "border-black bg-[#1A1A1A] text-[#DADADA] hover:bg-[#222222]"
                                    }`}
                                    loading={loadingSpeaker}
                                    onClick={() => handleSpeakerPermission(participantUserId, !speakerAccessEnabled)}
                                  >
                                    {speakerAccessEnabled ? "Revoke mic" : "Allow mic"}
                                  </Button>
                                </div>
                              ) : (
                                <div className="mt-2 text-[11px] text-[#8F8F8F]">
                                  Core moderation is inherited from host/instructor role.
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex max-h-[360px] flex-col sm:max-h-[420px] xl:h-[520px] xl:max-h-none">
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {messages.length === 0 ? (
                  <div className="rounded-[22px] border border-black panel-gradient px-4 py-3 text-sm text-[#BBBBBB]">
                    No messages yet.
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`rounded-[22px] border px-4 py-3 text-sm ${
                        message.isSelf
                          ? "ml-6 border-[#D7D7D7]/20 bg-[#212121] text-[#F1F1F1]"
                          : "mr-6 border-black panel-gradient text-[#E1E1E1]"
                      }`}
                    >
                      <div className="font-semibold text-white">{message.sender}</div>
                      <div className="mt-1 whitespace-pre-wrap break-words">{message.text}</div>
                    </div>
                  ))
                )}
              </div>
              <form onSubmit={sendMessage} className="border-t border-black p-4">
                <input
                  className="w-full rounded-full border border-black bg-[#141414]/92 px-4 py-3 text-sm text-black caret-black outline-none placeholder:text-[#949494] focus:border-[#C0C0C0]"
                  placeholder="Send a message"
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                />
                <Button
                  type="submit"
                  className="mt-3 w-full rounded-full border border-[#D7D7D7] bg-gradient-to-r from-[#DADADA] to-[#AFAFAF] py-3 text-[#121212] shadow-none hover:from-[#E5E5E5] hover:to-[#C0C0C0]"
                >
                  Send
                </Button>
              </form>
            </div>
          )}
          </aside>
        ) : null}
      </div>

      <div className="relative border-t border-black bg-[#131313]/84 px-4 py-4 backdrop-blur-sm">
        <div className="flex flex-wrap items-center justify-center gap-3">
          {effectiveCanPresent || effectiveCanSpeak ? (
          <>
            <Button
              variant={controls.mic ? "secondary" : "danger"}
              className={`min-w-[126px] rounded-full px-5 py-3 shadow-none ${
                !effectiveCanSpeak
                  ? "border-black bg-[#141414]/76 text-[#787878]"
                  : controls.mic
                  ? "border-black bg-[#141414]/92 text-[#DBDBDB] hover:bg-[#1B1B1B]"
                  : "border-[#A9A9A9] bg-[#737373] text-white hover:bg-[#616161]"
              }`}
              onClick={toggleMicrophone}
              loading={controlBusy}
              disabled={!effectiveCanSpeak}
            >
              {effectiveCanSpeak ? (controls.mic ? "Mute" : "Unmute") : "Mic locked"}
            </Button>
            {effectiveCanPresent ? (
              <>
                <Button
                  variant={controls.camera ? "secondary" : "danger"}
                  className={`min-w-[126px] rounded-full px-5 py-3 shadow-none ${
                    controls.camera
                      ? "border-black bg-[#141414]/92 text-[#DBDBDB] hover:bg-[#1B1B1B]"
                      : "border-[#A9A9A9] bg-[#737373] text-white hover:bg-[#616161]"
                  }`}
                  onClick={toggleCamera}
                  loading={controlBusy}
                >
                  {controls.camera ? "Camera off" : "Camera on"}
                </Button>
                <Button
                  variant={controls.screen ? "primary" : "secondary"}
                  className={`min-w-[148px] rounded-full px-5 py-3 shadow-none ${
                    controls.screen
                      ? "border border-[#D7D7D7] bg-gradient-to-r from-[#DADADA] to-[#AFAFAF] text-[#121212] hover:from-[#E5E5E5] hover:to-[#C0C0C0]"
                      : "border-black bg-[#141414]/92 text-[#DBDBDB] hover:bg-[#1B1B1B]"
                  }`}
                  onClick={toggleScreenShare}
                  loading={controlBusy}
                >
                  {controls.screen ? "Stop presenting" : "Present now"}
                </Button>
              </>
            ) : (
              <span className="rounded-full border border-black bg-[#141414]/86 px-4 py-3 text-sm text-[#E1E1E1]">
                Presenter-only: camera and screen share
              </span>
            )}
          </>
        ) : (
          <span className="rounded-full border border-black bg-[#141414]/86 px-4 py-3 text-sm text-[#E1E1E1]">
            Viewer mode: media publishing is disabled for this account.
          </span>
        )}
          <Button
            variant="danger"
            className="min-w-[126px] rounded-full border-[#A9A9A9] bg-[#737373] px-5 py-3 text-white shadow-none hover:bg-[#616161]"
            onClick={handleLeaveMeeting}
          >
            Leave
          </Button>
        </div>
      </div>
      <div className="relative border-t border-black panel-gradient px-4 py-3 text-xs text-[#949494] backdrop-blur-sm">
        For full desktop presentation, choose <span className="text-[#E1E1E1]">Entire Screen</span> in the browser share picker.
      </div>
    </section>
  );
}

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track, VideoQuality } from "livekit-client";
import Button from "../Button";
import {
  deleteRealtimeRecording,
  grantRealtimePresenter,
  listRealtimeRecordings,
  revokeRealtimePresenter,
  startRealtimeRecording,
  stopRealtimeRecording,
  uploadRealtimeBrowserRecording,
} from "../../api/realtime";
import { ScreenityFallbackRecorder } from "../../services/recording/ScreenityFallbackRecorder";
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

function getParticipantMediaState(participant) {
  const publications = Array.from(participant.trackPublications.values());

  const screenVideoPublication = publications.find(
    (publication) =>
      publication.source === Track.Source.ScreenShare &&
      publication.kind === Track.Kind.Video &&
      publication.track
  );
  const cameraVideoPublication = publications.find(
    (publication) =>
      publication.source === Track.Source.Camera &&
      publication.kind === Track.Kind.Video &&
      publication.track
  );
  const audioPublication =
    publications.find(
      (publication) =>
        publication.source === Track.Source.Microphone &&
        publication.kind === Track.Kind.Audio &&
        publication.track
    ) ||
    publications.find(
      (publication) => publication.kind === Track.Kind.Audio && publication.track
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

function MeetingTile({ entry, isFeatured = false, isSpeaking = false, isPinned = false, onPin }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  // Re-evaluate media state on each render so track switches (camera <-> screen) apply immediately.
  const mediaState = getParticipantMediaState(entry.participant);
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

  return (
    <article
      className={`relative overflow-hidden rounded-2xl border ${
        isSpeaking
          ? "border-[#d8e4cd]/70 shadow-[0_0_0_1px_rgba(216,228,205,0.4),0_18px_34px_rgba(0,0,0,0.33)]"
          : "border-[#2a3529]"
      } bg-black`}
    >
      <div className={`${tileHeightClass} w-full bg-[#040604]`}>
        {mediaState.videoTrack ? (
          <video ref={videoRef} autoPlay playsInline muted={entry.isLocal} className={`h-full w-full ${videoFitClass}`} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#101712] to-[#0a0f0a]">
            <span className="rounded-full border border-[#364337] bg-[#141c15] px-4 py-2 text-sm text-[#cfd7c8]">
              Camera Off
            </span>
          </div>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 py-2">
        <div className="truncate text-xs font-semibold text-white">{participantLabel(entry)}</div>
        <div className="flex items-center gap-2">
          {mediaState.hasScreenShare ? (
            <span className="rounded-full border border-[#425144] bg-[#172019] px-2 py-0.5 text-[10px] text-[#d9e3cf]">
              Screen
            </span>
          ) : null}
          {isPinned ? (
            <span className="rounded-full border border-[#425144] bg-[#172019] px-2 py-0.5 text-[10px] text-[#d9e3cf]">
              Pinned
            </span>
          ) : null}
          <button
            type="button"
            onClick={onPin}
            className="rounded-full border border-[#3b473b] bg-[#141b14] px-2 py-0.5 text-[10px] text-[#d9e3cf] hover:bg-[#1b251c]"
          >
            {isPinned ? "Unpin" : "Pin"}
          </button>
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

export default function MeetingRoomExperience({ payload, onLeave, audiencePanel = false }) {
  const session = payload?.session || {};
  const meeting = payload?.meeting || {};
  const canPresent = Boolean(meeting?.permissions?.can_present);
  const canSpeak = Boolean(meeting?.permissions?.can_speak || canPresent);
  const canManagePresenters = Boolean(meeting?.permissions?.can_manage_presenters);
  const audienceFocusMode = Boolean(audiencePanel && !canManagePresenters);
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
  const [presenterUserIds, setPresenterUserIds] = useState(() =>
    Array.isArray(meeting.presenter_user_ids) ? meeting.presenter_user_ids : []
  );
  const [permissionState, setPermissionState] = useState({
    loadingUserId: null,
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
  const [isStageFullscreen, setIsStageFullscreen] = useState(false);

  const syncParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) {
      setParticipants([]);
      return;
    }

    const localEntry = room.localParticipant
      ? [{ id: room.localParticipant.identity || room.localParticipant.sid, participant: room.localParticipant, isLocal: true }]
      : [];
    const remoteEntries = Array.from(room.remoteParticipants.values()).map((participant) => ({
      id: participant.identity || participant.sid,
      participant,
      isLocal: false,
    }));

    setParticipants([...localEntry, ...remoteEntries]);
  }, []);

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
      if (!premiumProfileEnabled || !publication || publication.kind !== Track.Kind.Video) {
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
    [mediaProfile.screenCaptureHeight, mediaProfile.screenCaptureWidth, mediaProfile.screenFps, premiumProfileEnabled]
  );

  useEffect(() => {
    setPresenterUserIds(Array.isArray(meeting.presenter_user_ids) ? meeting.presenter_user_ids : []);
    setPermissionState({ loadingUserId: null, error: "", info: "" });
  }, [meeting.presenter_user_ids, session.id]);

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
      adaptiveStream: premiumProfileEnabled ? false : true,
      dynacast: true,
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

    const refreshRoomState = () => {
      syncParticipants();
      syncLocalControls();
    };

    room.on(RoomEvent.ParticipantConnected, refreshRoomState);
    room.on(RoomEvent.ParticipantDisconnected, refreshRoomState);
    room.on(RoomEvent.LocalTrackPublished, refreshRoomState);
    room.on(RoomEvent.LocalTrackUnpublished, refreshRoomState);
    room.on(RoomEvent.TrackSubscribed, (_track, publication) => {
      enforceRemotePublicationQuality(publication);
      refreshRoomState();
    });
    room.on(RoomEvent.TrackUnsubscribed, refreshRoomState);
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
      syncParticipants();
    });
    room.on(RoomEvent.DataReceived, (payloadBytes, participant, _kind, topic) => {
      if (topic && topic !== "meeting-chat") {
        return;
      }
      if (!participant) {
        return;
      }

      try {
        const decoded = textDecoder.decode(payloadBytes);
        const parsed = JSON.parse(decoded);
        if (parsed.type !== "chat" || !parsed.text) {
          return;
        }
        if (parsed.identity && parsed.identity === meeting.participant_identity) {
          return;
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random()}`,
            identity: participant.identity || parsed.identity || "",
            sender: participant.name || parsed.sender || participant.identity || "Participant",
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
        await room.connect(meeting.livekit_url, meeting.token);
        await room.startAudio();
        for (const remoteParticipant of room.remoteParticipants.values()) {
          for (const publication of remoteParticipant.trackPublications.values()) {
            enforceRemotePublicationQuality(publication);
          }
        }

        if (canPresent) {
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
        } else if (canSpeak) {
          setMeetingInfo(
            "Audience mode: you can use microphone and chat. Camera/screen share are presenter-only. If admin updates meeting quality profile, rejoin to apply latest capture settings."
          );
        } else {
          setMeetingInfo("Viewer mode enabled. Only presenter-approved users can publish media.");
        }

        if (disposed) {
          return;
        }

        connectedAtRef.current = Date.now();
        setElapsedSeconds(0);
        refreshRoomState();
        setConnecting(false);
        setConnected(true);
        setConnectionLabel("connected");
        if (canPresent) {
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
        } else if (canSpeak) {
          setMeetingInfo("Connected. Meeting is live. Mic-enabled participant mode.");
        } else {
          setMeetingInfo("Connected. Meeting is live.");
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
      room.removeAllListeners();
      room.disconnect();
      roomRef.current = null;
      connectedAtRef.current = null;
    };
  }, [
    canPresent,
    canSpeak,
    enforceRemotePublicationQuality,
    mediaProfile.cameraCaptureHeight,
    mediaProfile.cameraCaptureWidth,
    mediaProfile.cameraFps,
    mediaProfile.cameraMaxVideoBitrateKbps,
    meeting.livekit_url,
    meeting.participant_identity,
    meeting.token,
    premiumProfileEnabled,
    syncLocalControls,
    syncParticipants,
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

  const featuredParticipant = useMemo(() => {
    if (pinnedIdentity) {
      return participantsOrdered.find((entry) => entry.participant.identity === pinnedIdentity) || null;
    }
    const screenshareOwner = participantsOrdered.find((entry) => getParticipantMediaState(entry.participant).hasScreenShare);
    if (screenshareOwner) {
      return screenshareOwner;
    }
    const activeSpeaker = participantsOrdered.find((entry) =>
      activeSpeakerIds.includes(entry.participant.identity)
    );
    return activeSpeaker || participantsOrdered[0] || null;
  }, [activeSpeakerIds, participantsOrdered, pinnedIdentity]);

  const otherParticipants = useMemo(() => {
    if (!featuredParticipant) {
      return [];
    }
    return participantsOrdered.filter((entry) => entry.id !== featuredParticipant.id);
  }, [featuredParticipant, participantsOrdered]);

  const featuredHasScreenShare = featuredParticipant
    ? getParticipantMediaState(featuredParticipant.participant).hasScreenShare
    : false;
  const useFeaturedLayout = Boolean(featuredParticipant) && (otherParticipants.length > 0 || featuredHasScreenShare);
  const stagePriorityMode = audienceFocusMode && !sidePanelOpen;
  const shareableJoinLink = buildJoinLink(session);

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
    if (permissionRequirement === "speak" && !canSpeak) {
      setMeetingError("Microphone access is disabled for your role in this meeting.");
      return;
    }
    if (permissionRequirement === "present" && !canPresent) {
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

  const handlePresenterPermission = async (userId, grantAccess) => {
    if (!canManagePresenters || !session.id || !userId) {
      return;
    }
    setPermissionState({ loadingUserId: userId, error: "", info: "" });
    try {
      const response = grantAccess
        ? await grantRealtimePresenter(session.id, userId)
        : await revokeRealtimePresenter(session.id, userId);
      const data = apiData(response, {});
      const nextPresenterIds = Array.isArray(data.presenter_user_ids) ? data.presenter_user_ids : [];
      setPresenterUserIds(nextPresenterIds);
      setPermissionState({
        loadingUserId: null,
        error: "",
        info: `${grantAccess ? "Presenter access granted" : "Presenter access revoked"} for user ${userId}. Rejoin required to apply.`,
      });
    } catch (err) {
      setPermissionState({
        loadingUserId: null,
        error: apiMessage(err, "Unable to update presenter permission."),
        info: "",
      });
    }
  };

  const handleStartRecording = async () => {
    if (!session.id || !canManagePresenters) {
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
    if (!session.id || !canManagePresenters) {
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
    if (!session.id || !canManagePresenters) {
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
    } catch {
      setMeetingError("Unable to send message.");
    }
  };

  return (
    <section className="mb-6 overflow-hidden rounded-[28px] border border-[#263326] bg-[#070b07]/94 shadow-[0_24px_55px_rgba(0,0,0,0.35)]">
      <div className="border-b border-[#253126] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-reference text-xl font-semibold text-white">{session.title || "Meeting Room"}</h3>
            <p className="mt-1 text-xs text-[#8f9989]">
              Room: {meeting.room_name || "-"} | Status: {connectionLabel}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-[#344235] bg-[#121912] px-3 py-1 text-xs text-[#d5ddcb]">
              {participantCount} participant{participantCount === 1 ? "" : "s"}
            </span>
            <span className="rounded-full border border-[#344235] bg-[#121912] px-3 py-1 text-xs text-[#d5ddcb]">
              {liveDurationLabel || "--:--"}
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <code className="max-w-full truncate rounded-md border border-[#2d382f] bg-[#111811] px-2 py-1 text-xs text-[#dbe4d1]">
            {shareableJoinLink || "Join link unavailable"}
          </code>
          <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={handleCopyJoinLink}>
            Copy Link
          </Button>
          {audienceFocusMode ? (
            <>
              <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setSidePanelOpen((prev) => !prev)}>
                {sidePanelOpen ? "Hide Chat Panel" : "Open Chat Panel"}
              </Button>
              <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={toggleStageFullscreen}>
                {isStageFullscreen ? "Exit Fullscreen" : "Fullscreen"}
              </Button>
            </>
          ) : null}
        </div>
        {canManagePresenters ? (
          <div className="mt-3 rounded-lg border border-[#2f3f31] bg-[#111a12] px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-[#d5ddcb]">
                Recording: {recordingState.active?.status || "idle"}
                {recordingState.active
                  ? ` (${recordingState.mode === "screenity-fallback" ? "browser fallback" : "livekit"})`
                  : ""}
              </span>
              <Button
                className="px-3 py-1.5 text-xs"
                onClick={handleStartRecording}
                loading={recordingState.loading}
                disabled={Boolean(recordingState.active)}
              >
                Start Recording
              </Button>
              <Button
                variant="danger"
                className="px-3 py-1.5 text-xs"
                onClick={handleStopRecording}
                loading={recordingState.loading}
                disabled={!recordingState.active}
              >
                Stop Recording
              </Button>
              {resolveRecordingPlaybackUrl(recordingState.latestCompleted) ? (
                <a
                  href={resolveRecordingPlaybackUrl(recordingState.latestCompleted)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-[#3d4c3f] bg-[#151f16] px-3 py-1.5 text-xs text-[#dbe4d1] hover:bg-[#1d2a1f]"
                >
                  Open Last Recording
                </a>
              ) : null}
              <Button
                variant="danger"
                className="px-3 py-1.5 text-xs"
                onClick={handleDeleteLatestRecording}
                loading={recordingState.loading}
                disabled={!recordingState.latestCompleted?.id || Boolean(recordingState.active)}
              >
                Delete Last Recording
              </Button>
            </div>
            {recordingState.error ? (
              <p className="mt-2 text-xs text-red-300">{recordingState.error}</p>
            ) : null}
            {recordingState.info ? (
              <p className="mt-2 text-xs text-green-300">{recordingState.info}</p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={sidePanelOpen ? "grid gap-0 xl:grid-cols-[minmax(0,1fr)_320px]" : "grid gap-0"}>
        <div
          ref={stageRef}
          className={`${
            stagePriorityMode
              ? "min-h-[58vh] sm:min-h-[66vh] lg:min-h-[74vh]"
              : "min-h-[340px] sm:min-h-[460px] lg:min-h-[520px]"
          } bg-[#060906] p-4 sm:p-5`}
        >
          {connecting ? (
            <div className="flex h-[220px] items-center justify-center rounded-2xl border border-[#273226] bg-[#0e140e] text-[#d5ddcb] sm:h-[320px] lg:h-[460px]">
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
                    featuredHasScreenShare ? "xl:grid-cols-[minmax(0,1fr)_260px]" : "lg:grid-cols-[1fr_220px]"
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
              {participantsOrdered.map((entry) => (
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
            <div className="mt-3 rounded-lg border border-red-300/30 bg-red-300/10 px-3 py-2 text-xs text-red-200">
              {meetingError}
            </div>
          ) : null}
          {meetingInfo ? (
            <div className="mt-3 rounded-lg border border-[#2f3f31] bg-[#111a12] px-3 py-2 text-xs text-[#d5ddcb]">
              {meetingInfo}
            </div>
          ) : null}
          {permissionState.error ? (
            <div className="mt-3 rounded-lg border border-red-300/30 bg-red-300/10 px-3 py-2 text-xs text-red-200">
              {permissionState.error}
            </div>
          ) : null}
          {permissionState.info ? (
            <div className="mt-3 rounded-lg border border-[#2f3f31] bg-[#111a12] px-3 py-2 text-xs text-[#d5ddcb]">
              {permissionState.info}
            </div>
          ) : null}
        </div>

        {sidePanelOpen ? (
          <aside className="border-t border-[#253126] bg-[#0c120d] xl:border-l xl:border-t-0">
          <div className="flex border-b border-[#253126]">
            <button
              type="button"
              className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] ${
                panelTab === "people" ? "bg-[#131c14] text-white" : "text-[#8f9989]"
              }`}
              onClick={() => setPanelTab("people")}
            >
              People
            </button>
            <button
              type="button"
              className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] ${
                panelTab === "chat" ? "bg-[#131c14] text-white" : "text-[#8f9989]"
              }`}
              onClick={() => setPanelTab("chat")}
            >
              Chat
            </button>
          </div>

          {panelTab === "people" ? (
            <div className="max-h-[320px] overflow-y-auto p-3 sm:max-h-[420px] xl:h-[520px] xl:max-h-none">
              <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[#8f9989]">
                Participants ({participantCount})
              </div>
              <div className="space-y-2">
                {participantsOrdered.map((entry) => {
                  const media = getParticipantMediaState(entry.participant);
                  const participantUserId = parseUserIdFromIdentity(entry.participant.identity);
                  const presenterOverrideEnabled =
                    participantUserId && presenterUserIds.includes(participantUserId);
                  return (
                    <div
                      key={entry.id}
                      className="rounded-xl border border-[#273327] bg-[#101711] px-3 py-2 text-xs text-[#d6decf]"
                    >
                      <div className="truncate font-semibold text-white">{participantLabel(entry)}</div>
                      <div className="mt-1 text-[#9eaa97]">
                        {media.hasCamera ? "Camera On" : "Camera Off"} |{" "}
                        {media.hasAudio ? "Mic On" : "Mic Off"}
                        {media.hasScreenShare ? " | Sharing screen" : ""}
                      </div>
                      <div className="mt-1 text-[#9eaa97]">
                        {presenterOverrideEnabled ? "Presenter permission: Granted" : "Presenter permission: Default"}
                      </div>
                      {canManagePresenters && participantUserId && !entry.isLocal ? (
                        <div className="mt-2">
                          <Button
                            variant={presenterOverrideEnabled ? "danger" : "secondary"}
                            className="w-full px-2 py-1 text-xs"
                            loading={permissionState.loadingUserId === participantUserId}
                            onClick={() =>
                              handlePresenterPermission(participantUserId, !presenterOverrideEnabled)
                            }
                          >
                            {presenterOverrideEnabled ? "Revoke Presenter Access" : "Grant Presenter Access"}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex max-h-[360px] flex-col sm:max-h-[420px] xl:h-[520px] xl:max-h-none">
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {messages.length === 0 ? (
                  <div className="rounded-xl border border-[#273327] bg-[#101711] px-3 py-2 text-xs text-[#9eaa97]">
                    No messages yet.
                  </div>
                ) : (
                  messages.map((message) => (
                    <div
                      key={message.id}
                      className={`rounded-xl border px-3 py-2 text-xs ${
                        message.isSelf
                          ? "border-[#41513f] bg-[#192419] text-[#e5ede0]"
                          : "border-[#273327] bg-[#101711] text-[#d6decf]"
                      }`}
                    >
                      <div className="font-semibold text-white">{message.sender}</div>
                      <div className="mt-1 whitespace-pre-wrap break-words">{message.text}</div>
                    </div>
                  ))
                )}
              </div>
              <form onSubmit={sendMessage} className="border-t border-[#253126] p-3">
                <input
                  className="w-full rounded-xl border border-[#2a3a2c] bg-[#0c120d] px-3 py-2 text-sm text-white outline-none focus:border-[#8ea284]"
                  placeholder="Send a message"
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                />
                <Button type="submit" className="mt-2 w-full">
                  Send
                </Button>
              </form>
            </div>
          )}
          </aside>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-[#253126] bg-[#090f09] px-3 py-3">
        {(canPresent || canSpeak) ? (
          <>
            <Button
              variant={controls.mic ? "secondary" : "danger"}
              className="min-w-[110px]"
              onClick={toggleMicrophone}
              loading={controlBusy}
            >
              {controls.mic ? "Mute" : "Unmute"}
            </Button>
            {canPresent ? (
              <>
                <Button
                  variant={controls.camera ? "secondary" : "danger"}
                  className="min-w-[110px]"
                  onClick={toggleCamera}
                  loading={controlBusy}
                >
                  {controls.camera ? "Camera Off" : "Camera On"}
                </Button>
                <Button
                  variant={controls.screen ? "primary" : "secondary"}
                  className="min-w-[130px]"
                  onClick={toggleScreenShare}
                  loading={controlBusy}
                >
                  {controls.screen ? "Stop Share" : "Present Now"}
                </Button>
              </>
            ) : (
              <span className="rounded-full border border-[#344235] bg-[#121912] px-3 py-1 text-xs text-[#d5ddcb]">
                Presenter-only: camera and screen share
              </span>
            )}
          </>
        ) : (
          <span className="rounded-full border border-[#344235] bg-[#121912] px-3 py-1 text-xs text-[#d5ddcb]">
            Viewer mode: media publishing is disabled for this account.
          </span>
        )}
        <Button variant="danger" className="min-w-[110px]" onClick={handleLeaveMeeting}>
          Leave
        </Button>
      </div>
      <div className="border-t border-[#1f291f] bg-[#070d07] px-3 py-2 text-[11px] text-[#8f9c89]">
        For full desktop presentation, choose <span className="text-[#d5ddcb]">Entire Screen</span> in the browser share picker.
      </div>
    </section>
  );
}

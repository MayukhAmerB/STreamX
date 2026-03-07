const DEFAULT_VIDEO_BITS_PER_SECOND = 8_000_000;
const DEFAULT_AUDIO_BITS_PER_SECOND = 192_000;
const SUPPORTED_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function resolveSupportedMimeType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return SUPPORTED_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function buildRecordingFileName(prefix = "screenity-fallback") {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${timestamp}.webm`;
}

export class ScreenityFallbackRecorder {
  constructor({
    withMicrophone = false,
    videoBitsPerSecond = DEFAULT_VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond = DEFAULT_AUDIO_BITS_PER_SECOND,
  } = {}) {
    this.withMicrophone = Boolean(withMicrophone);
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.audioBitsPerSecond = audioBitsPerSecond;
    this.mimeType = resolveSupportedMimeType();

    this._displayStream = null;
    this._microphoneStream = null;
    this._mixedAudioContext = null;
    this._mixedDestination = null;
    this._combinedStream = null;
    this._recorder = null;
    this._chunks = [];
    this._startedAt = null;
  }

  get isRecording() {
    return Boolean(this._recorder && this._recorder.state === "recording");
  }

  async start() {
    if (this.isRecording) {
      throw new Error("Fallback recorder is already running.");
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen recording is not supported in this browser.");
    }
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not available in this browser.");
    }

    this._displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 30,
      },
      audio: true,
    });

    let audioTracks = [...this._displayStream.getAudioTracks()];
    if (this.withMicrophone && navigator.mediaDevices?.getUserMedia) {
      try {
        this._microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const displaySource = context.createMediaStreamSource(this._displayStream);
        displaySource.connect(destination);
        const micSource = context.createMediaStreamSource(this._microphoneStream);
        micSource.connect(destination);
        this._mixedAudioContext = context;
        this._mixedDestination = destination;
        audioTracks = destination.stream.getAudioTracks();
      } catch {
        // Microphone is optional for fallback; continue with display audio only.
      }
    }

    const combinedTracks = [
      ...this._displayStream.getVideoTracks(),
      ...audioTracks,
    ];
    this._combinedStream = new MediaStream(combinedTracks);

    const recorderOptions = {
      videoBitsPerSecond: this.videoBitsPerSecond,
      audioBitsPerSecond: this.audioBitsPerSecond,
    };
    if (this.mimeType) {
      recorderOptions.mimeType = this.mimeType;
    }
    this._recorder = new MediaRecorder(this._combinedStream, recorderOptions);
    this._chunks = [];
    this._startedAt = new Date();

    this._recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this._chunks.push(event.data);
      }
    };

    const displayVideoTrack = this._displayStream.getVideoTracks()[0];
    if (displayVideoTrack) {
      displayVideoTrack.onended = () => {
        if (this.isRecording) {
          this.stop().catch(() => {
            // no-op
          });
        }
      };
    }

    this._recorder.start(1000);
    return {
      mode: "screenity-fallback",
      started_at: this._startedAt.toISOString(),
    };
  }

  async stop() {
    if (!this._recorder) {
      throw new Error("Fallback recorder is not active.");
    }

    const recorder = this._recorder;
    await new Promise((resolve, reject) => {
      const handleStop = () => resolve();
      const handleError = (event) => reject(event?.error || new Error("Unable to stop fallback recorder."));
      recorder.addEventListener("stop", handleStop, { once: true });
      recorder.addEventListener("error", handleError, { once: true });
      try {
        recorder.stop();
      } catch (error) {
        reject(error);
      }
    });

    const endedAt = new Date();
    const blob = new Blob(this._chunks, {
      type: this.mimeType || "video/webm",
    });
    const fileName = buildRecordingFileName();
    const file = new File([blob], fileName, {
      type: blob.type || "video/webm",
      lastModified: Date.now(),
    });

    this._cleanup();

    return {
      mode: "screenity-fallback",
      blob,
      file,
      file_name: fileName,
      mime_type: blob.type || "video/webm",
      started_at: this._startedAt ? this._startedAt.toISOString() : "",
      ended_at: endedAt.toISOString(),
      duration_ms: this._startedAt ? endedAt.getTime() - this._startedAt.getTime() : 0,
    };
  }

  _stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // no-op
      }
    });
  }

  _cleanup() {
    this._stopStream(this._combinedStream);
    this._stopStream(this._displayStream);
    this._stopStream(this._microphoneStream);
    if (this._mixedAudioContext) {
      try {
        this._mixedAudioContext.close();
      } catch {
        // no-op
      }
    }
    this._displayStream = null;
    this._microphoneStream = null;
    this._combinedStream = null;
    this._mixedAudioContext = null;
    this._mixedDestination = null;
    this._recorder = null;
    this._chunks = [];
    this._startedAt = null;
  }
}

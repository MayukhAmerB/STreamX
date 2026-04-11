import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getMyCourses, listLiveClasses } from "../api/courses";
import BrandLogo from "../components/BrandLogo";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiData } from "../utils/api";

const DEFAULT_ID_CARD_PROFILE_IMAGE =
  "https://i.pinimg.com/736x/43/7a/79/437a79e87c5dde8694de6d8c787543f4.jpg";

function formatDateLabel(value) {
  if (!value) {
    return "Not available";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Not available";
  }
  return parsed.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTimestamp(value) {
  return value.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function deriveHandle(user) {
  const emailLocal = String(user?.email || "")
    .split("@")[0]
    .replace(/[^a-zA-Z0-9._-]+/g, "")
    .slice(0, 24);
  if (emailLocal) {
    return `@${emailLocal.toLowerCase()}`;
  }
  const fallback = String(user?.full_name || "alsyedmember")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 18);
  return `@${fallback || "alsyedmember"}`;
}

function deriveRoleLabel(user) {
  if (user?.is_admin) {
    return "Administrator";
  }
  if (user?.role === "instructor") {
    return "Instructor";
  }
  return "Student";
}

function buildCardId(userId) {
  return `AL-SYD-${String(userId || 0).padStart(5, "0")}`;
}

function buildBarcodeBars(seed) {
  const normalized = String(seed || "alsyed");
  const bars = [];
  let rolling = 17;

  for (let index = 0; index < 44; index += 1) {
    const code = normalized.charCodeAt(index % normalized.length) || 47;
    rolling = (rolling * 31 + code + index * 13) % 9973;
    bars.push({
      width: 1 + (rolling % 3),
      height: 12 + (rolling % 9),
    });
  }

  return bars;
}

function buildWatermarkLines(text) {
  return Array.from({ length: 5 }, (_, rowIndex) => ({
    key: rowIndex,
    top: `${14 + rowIndex * 17}%`,
    text: Array.from({ length: 4 }, () => text).join("   //   "),
  }));
}

function deriveClearanceLabel(user) {
  if (user?.is_admin) {
    return "LV5";
  }
  if (user?.role === "instructor") {
    return "LV4";
  }
  return "LV3";
}

export default function IdCardPage() {
  const { user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [liveClasses, setLiveClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dataNotice, setDataNotice] = useState("");
  const [shieldActive, setShieldActive] = useState(false);
  const [timestamp, setTimestamp] = useState(() => new Date());
  const matrixCanvasRef = useRef(null);
  const matrixShellRef = useRef(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTimestamp(new Date());
    }, 60000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setShieldActive(document.hidden);
    };

    const handleBeforePrint = () => setShieldActive(true);
    const handleAfterPrint = () => setShieldActive(false);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, []);

  useEffect(() => {
    const canvas = matrixCanvasRef.current;
    const shell = matrixShellRef.current;
    if (!canvas || !shell) {
      return undefined;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return undefined;
    }

    const fontSize = 12;
    let drops = [];
    let intervalId = null;
    let resizeObserver = null;

    const resizeCanvas = () => {
      const bounds = shell.getBoundingClientRect();
      const width = Math.max(1, Math.floor(bounds.width));
      const height = Math.max(1, Math.floor(bounds.height));
      canvas.width = width;
      canvas.height = height;
      drops = Array(Math.max(1, Math.floor(width / fontSize))).fill(1);
    };

    const drawMatrix = () => {
      context.fillStyle = "rgba(3,3,3,0.05)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgba(255,255,255,0.8)";
      context.font = `${fontSize}px monospace`;

      for (let index = 0; index < drops.length; index += 1) {
        const glyph = Math.random() > 0.5 ? "1" : "0";
        context.fillText(glyph, index * fontSize, drops[index] * fontSize);
        if (drops[index] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[index] = 0;
        }
        drops[index] += 1;
      }
    };

    resizeCanvas();
    intervalId = window.setInterval(drawMatrix, 50);
    window.addEventListener("resize", resizeCanvas);

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(resizeCanvas);
      resizeObserver.observe(shell);
    }

    return () => {
      if (intervalId) {
        window.clearInterval(intervalId);
      }
      window.removeEventListener("resize", resizeCanvas);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setCourses([]);
      setLiveClasses([]);
      setLoading(false);
      return undefined;
    }

    let active = true;

    (async () => {
      setLoading(true);
      setDataNotice("");

      const [courseResult, liveClassResult] = await Promise.allSettled([
        getMyCourses(),
        listLiveClasses(),
      ]);

      if (!active) {
        return;
      }

      let partialFailures = 0;

      if (courseResult.status === "fulfilled") {
        setCourses(apiData(courseResult.value, []));
      } else {
        setCourses([]);
        partialFailures += 1;
      }

      if (liveClassResult.status === "fulfilled") {
        setLiveClasses(apiData(liveClassResult.value, []));
      } else {
        setLiveClasses([]);
        partialFailures += 1;
      }

      if (partialFailures > 0) {
        setDataNotice("Some live/course enrichment could not be loaded right now. Identity details are still accurate.");
      }

      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [user?.id]);

  const userInitials = useMemo(() => {
    const source = String(user?.full_name || user?.email || "U").trim();
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
    }
    return source.slice(0, 2).toUpperCase();
  }, [user?.email, user?.full_name]);

  const roleLabel = useMemo(() => deriveRoleLabel(user), [user]);
  const clearanceLabel = useMemo(() => deriveClearanceLabel(user), [user]);
  const handleLabel = useMemo(() => deriveHandle(user), [user]);
  const usernameLabel = useMemo(() => handleLabel.replace(/^@/, "") || "alsyedmember", [handleLabel]);
  const joinedLabel = useMemo(() => formatDateLabel(user?.created_at), [user?.created_at]);
  const memberId = useMemo(() => buildCardId(user?.id), [user?.id]);
  const barcodeBars = useMemo(
    () => buildBarcodeBars(`${user?.id || 0}:${user?.email || "alsyed"}`),
    [user?.email, user?.id]
  );
  const approvedLiveClasses = useMemo(
    () =>
      liveClasses
        .filter((item) => item?.is_enrolled || item?.enrollment_status === "approved")
        .sort((left, right) => (left?.month_number || 0) - (right?.month_number || 0)),
    [liveClasses]
  );
  const primaryLiveClass = approvedLiveClasses[0] || null;
  const primaryCourse = courses[0] || null;
  const watermarkLabel = useMemo(
    () => `${memberId} // ${user?.email || "private"} // ${formatTimestamp(timestamp)} // PRIVATE CREDENTIAL`,
    [memberId, timestamp, user?.email]
  );
  const watermarkLines = useMemo(() => buildWatermarkLines(watermarkLabel), [watermarkLabel]);
  const profileImageUrl = user?.profile_image_url || DEFAULT_ID_CARD_PROFILE_IMAGE;
  const hasProfileName = Boolean(String(user?.full_name || "").trim());
  const hasProfilePhone = Boolean(String(user?.phone_number || "").trim());
  const hasProfileImage = Boolean(user?.profile_image_url);
  const hasCourseAccess = courses.length > 0;
  const hasLiveAccess = approvedLiveClasses.length > 0;
  const completedCheckpointCount = [
    hasProfileName,
    hasProfilePhone,
    hasProfileImage,
    hasCourseAccess,
    hasLiveAccess,
  ].filter(Boolean).length;
  const memberVerificationLabel =
    hasProfileName && hasProfilePhone && hasProfileImage ? "Verified" : "Not Verified";
  const memberVerificationSubLabel =
    memberVerificationLabel === "Verified" ? "identity confirmed" : "membership pending";
  const rankHeading = user?.id ? `#${user.id}` : "#0000";

  const profileReadiness = useMemo(() => {
    const hasImage = hasProfileImage;
    const hasPhone = hasProfilePhone;
    const hasName = hasProfileName;
    const completedSignals = [hasImage, hasPhone, hasName].filter(Boolean).length;

    if (completedSignals === 3) {
      return {
        label: "Profile Ready",
        sublabel: "Name, phone, and image are all on file.",
        tone: "text-[#E5E5E5]",
        accent: "bg-[#EFEFEF]",
      };
    }

    return {
      label: "Needs Update",
      sublabel: "Complete your profile details for a stronger identity record.",
        tone: "text-[#D7B88C]",
        accent: "bg-[#D7B88C]",
      };
  }, [hasProfileImage, hasProfileName, hasProfilePhone]);

  const securitySummary = useMemo(() => {
    if (user?.two_factor_enabled) {
      return {
        label: "2FA Enabled",
        sublabel: "This account has an extra authentication step enabled.",
        tone: "text-[#E5E5E5]",
      };
    }

    return {
      label: "2FA Off",
      sublabel: "Two-factor authentication is not enabled on this account yet.",
      tone: "text-[#D7B88C]",
    };
  }, [user?.two_factor_enabled]);

  const accessSummary = useMemo(
    () => `${courses.length} course${courses.length === 1 ? "" : "s"} // ${approvedLiveClasses.length} live class${approvedLiveClasses.length === 1 ? "" : "es"}`,
    [approvedLiveClasses.length, courses.length]
  );
  const idCardLevelLabel = "Cyber Security Apprentice";

  const preventSurfaceCaptureShortcuts = (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      ["p", "s"].includes(String(event.key || "").toLowerCase())
    ) {
      event.preventDefault();
    }
  };

  return (
    <PageShell
      title="ID Card"
      subtitle="Private credential view for the authenticated account only. There is no user-id route for this card, so every viewer only sees their own identity data."
      badge="Personal Credential"
      action={
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/profile">
            <Button variant="secondary">Edit Profile</Button>
          </Link>
          <Link to="/my-courses">
            <Button>Open Courses</Button>
          </Link>
        </div>
      }
    >
      <style>{`
        @keyframes idCardSweep {
          0% { transform: translateY(-100%); opacity: 0; }
          12% { opacity: 0.4; }
          100% { transform: translateY(620px); opacity: 0; }
        }

        @keyframes idCardBlink {
          0%, 100% { opacity: 0.9; box-shadow: 0 0 8px rgba(255,255,255,0.25); }
          50% { opacity: 0.25; box-shadow: 0 0 16px rgba(255,255,255,0.42); }
        }

        @keyframes idCardFloat {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-6px); }
        }

        @keyframes idCardHoloShift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }

        @keyframes idCardGlitch {
          0% { text-shadow: 2px 0 rgba(130,150,210,.35), -2px 0 rgba(255,255,255,.15); }
          25% { text-shadow: -2px 0 rgba(130,150,210,.35), 2px 0 rgba(255,255,255,.15); }
          50% { text-shadow: 1px 0 rgba(130,150,210,.35), -1px 0 rgba(255,255,255,.15); }
          75% { text-shadow: -1px 0 rgba(130,150,210,.35), 1px 0 rgba(255,255,255,.15); }
          100% { text-shadow: none; }
        }

        .asi-id-card-shell {
          position: relative;
          overflow: hidden;
          border-radius: 34px;
          border: 1px solid #000;
          padding: 22px;
          box-shadow: 0 28px 80px rgba(0,0,0,0.34);
          background:
            radial-gradient(circle at 18% 6%, rgba(255,255,255,0.06), transparent 28%),
            radial-gradient(circle at 92% 86%, rgba(187,187,187,0.06), transparent 28%),
            linear-gradient(180deg, rgba(255,255,255,0.015), transparent 42%),
            #030303;
        }

        .asi-id-card-shell::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: 1;
          opacity: 0.03;
          pointer-events: none;
          background-image: url("https://grainy-gradients.vercel.app/noise.svg");
        }

        .asi-id-card-matrix {
          position: absolute;
          inset: 0;
          z-index: 0;
          opacity: 0.025;
        }

        .asi-id-card-matrix canvas {
          width: 100%;
          height: 100%;
          display: block;
        }

        .asi-id-card-glow {
          position: absolute;
          width: 600px;
          height: 400px;
          border-radius: 999px;
          filter: blur(120px);
          pointer-events: none;
          z-index: 0;
        }

        .asi-id-card-glow-1 {
          background: radial-gradient(circle, rgba(100,120,200,.05), transparent 70%);
          top: -20%;
          left: -10%;
        }

        .asi-id-card-glow-2 {
          background: radial-gradient(circle, rgba(160,140,200,.035), transparent 70%);
          bottom: -20%;
          right: -10%;
        }

        .asi-id-card-card {
          position: relative;
          z-index: 4;
          overflow: hidden;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,.08);
          background: linear-gradient(165deg,#161616 0%,#0c0c0c 40%,#080808 100%);
          box-shadow:
            0 30px 60px -15px rgba(0,0,0,.9),
            0 0 0 1px rgba(255,255,255,.03),
            inset 0 1px 0 rgba(255,255,255,.07),
            inset 0 -1px 0 rgba(0,0,0,.5);
        }

        .asi-id-card-card::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 45%;
          z-index: 2;
          pointer-events: none;
          background: linear-gradient(180deg, rgba(255,255,255,.035) 0%, transparent 100%);
          border-radius: 14px 14px 0 0;
        }

        .asi-id-card-card::after {
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          height: 1px;
          z-index: 5;
          pointer-events: none;
          background: linear-gradient(to right, transparent 3%, rgba(130,150,210,.15) 25%, rgba(255,255,255,.3) 50%, rgba(130,150,210,.15) 75%, transparent 97%);
          animation: idCardSweep 6s linear infinite;
        }

        .asi-id-card-stripe {
          height: 2px;
          opacity: 0.6;
          background: linear-gradient(90deg,#1a1a1a,#667 20%,#fff 50%,#667 80%,#1a1a1a);
          background-size: 300% 100%;
          animation: idCardHoloShift 5s ease-in-out infinite;
        }

        .asi-id-card-corner {
          position: absolute;
          width: 8px;
          height: 8px;
          z-index: 3;
          pointer-events: none;
        }

        .asi-id-card-corner-tl {
          top: 4px;
          left: 4px;
          border-top: 1px solid rgba(255,255,255,.07);
          border-left: 1px solid rgba(255,255,255,.07);
        }

        .asi-id-card-corner-tr {
          top: 4px;
          right: 4px;
          border-top: 1px solid rgba(255,255,255,.07);
          border-right: 1px solid rgba(255,255,255,.07);
        }

        .asi-id-card-corner-bl {
          bottom: 4px;
          left: 4px;
          border-bottom: 1px solid rgba(255,255,255,.07);
          border-left: 1px solid rgba(255,255,255,.07);
        }

        .asi-id-card-corner-br {
          bottom: 4px;
          right: 4px;
          border-bottom: 1px solid rgba(255,255,255,.07);
          border-right: 1px solid rgba(255,255,255,.07);
        }

        .asi-id-card-inner {
          position: relative;
          z-index: 4;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 16px 20px 12px;
        }

        .asi-id-card-org-label,
        .asi-id-card-id-badge,
        .asi-id-card-handle,
        .asi-id-card-username,
        .asi-id-card-info-label,
        .asi-id-card-section-title,
        .asi-id-card-course-name,
        .asi-id-card-status-text,
        .asi-id-card-status-sub,
        .asi-id-card-footer {
          font-family: "JetBrains Mono", monospace;
        }

        .asi-id-card-display-name,
        .asi-id-card-rank-icon {
          font-family: "Oswald", sans-serif;
        }

        .asi-id-card-top-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .asi-id-card-org-label {
          white-space: nowrap;
          border-radius: 4px;
          border: 1px solid rgba(255,255,255,.07);
          padding: 3px 8px;
          font-size: 7px;
          font-weight: 600;
          letter-spacing: .18em;
          text-transform: uppercase;
          color: rgba(255,255,255,.45);
          background: linear-gradient(135deg, rgba(255,255,255,.025), transparent);
        }

        .asi-id-card-id-badge {
          text-align: right;
          white-space: nowrap;
          font-size: 7px;
          line-height: 1.4;
          letter-spacing: .1em;
          color: rgba(255,255,255,.12);
        }

        .asi-id-card-id-badge span {
          color: rgba(255,255,255,.35);
        }

        .asi-id-card-identity-row {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .asi-id-card-avatar {
          position: relative;
          display: flex;
          width: 52px;
          height: 52px;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,.09);
          background: linear-gradient(145deg,#141414,#0a0a0a);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
          animation: idCardFloat 6s ease-in-out infinite;
        }

        .asi-id-card-avatar::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(135deg, rgba(130,150,210,.05), transparent 60%);
        }

        .asi-id-card-avatar img {
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .asi-id-card-avatar-status {
          position: absolute;
          right: 2px;
          bottom: 2px;
          z-index: 2;
          width: 6px;
          height: 6px;
          border-radius: 999px;
          border: 1.5px solid #0c0c0c;
          background: #fff;
          box-shadow: 0 0 5px rgba(255,255,255,.3);
          animation: idCardBlink 2s ease-in-out infinite;
        }

        .asi-id-card-handle {
          font-size: 8px;
          color: rgba(255,255,255,.25);
        }

        .asi-id-card-display-name {
          font-size: 18px;
          font-weight: 400;
          line-height: 1.1;
          letter-spacing: -.01em;
          color: #fff;
        }

        .asi-id-card-display-name:hover {
          animation: idCardGlitch .3s ease-in-out;
        }

        .asi-id-card-username {
          font-size: 8px;
          color: rgba(255,255,255,.12);
        }

        .asi-id-card-username span {
          color: rgba(255,255,255,.35);
        }

        .asi-id-card-divider {
          height: 1px;
          flex-shrink: 0;
          background: linear-gradient(to right, rgba(255,255,255,.07), rgba(255,255,255,.025), transparent);
        }

        .asi-id-card-info-strip {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 16px;
        }

        .asi-id-card-info-item {
          display: flex;
          align-items: center;
          gap: 5px;
        }

        .asi-id-card-info-label {
          font-size: 6.5px;
          font-weight: 600;
          letter-spacing: .14em;
          text-transform: uppercase;
          color: rgba(255,255,255,.1);
        }

        .asi-id-card-info-value {
          font-family: "JetBrains Mono", monospace;
          font-size: 9px;
          font-weight: 500;
          color: rgba(255,255,255,.55);
        }

        .asi-id-card-live-badge {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          border-radius: 3px;
          border: 1px solid rgba(255,255,255,.08);
          padding: 2px 6px;
          font-family: "JetBrains Mono", monospace;
          font-size: 6.5px;
          font-weight: 600;
          letter-spacing: .1em;
          text-transform: uppercase;
          color: rgba(255,255,255,.85);
          background: rgba(255,255,255,.04);
        }

        .asi-id-card-live-dot {
          width: 3px;
          height: 3px;
          border-radius: 999px;
          background: #fff;
          animation: idCardBlink 1.2s ease-in-out infinite;
        }

        .asi-id-card-courses-row {
          display: grid;
          gap: 8px;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .asi-id-card-section-header {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-bottom: 3px;
        }

        .asi-id-card-section-dot {
          width: 3px;
          height: 3px;
          border-radius: 999px;
          background: #fff;
          opacity: .45;
        }

        .asi-id-card-section-dot-blue {
          background: rgba(130,150,210,.5);
          box-shadow: 0 0 3px rgba(130,150,210,.25);
        }

        .asi-id-card-section-dot-red {
          background: rgba(200,80,80,.5);
          box-shadow: 0 0 3px rgba(200,80,80,.25);
        }

        .asi-id-card-section-dot-gold {
          background: rgba(200,180,100,.5);
          box-shadow: 0 0 3px rgba(200,180,100,.25);
        }

        .asi-id-card-section-title {
          font-size: 6.5px;
          font-weight: 600;
          letter-spacing: .14em;
          text-transform: uppercase;
          color: rgba(255,255,255,.18);
        }

        .asi-id-card-course-item,
        .asi-id-card-status-block {
          display: flex;
          align-items: center;
          gap: 6px;
          border-radius: 5px;
          border: 1px solid rgba(255,255,255,.025);
          padding: 5px 8px;
          background: rgba(255,255,255,.01);
          transition: all .3s ease;
        }

        .asi-id-card-course-item:hover,
        .asi-id-card-status-block:hover {
          border-color: rgba(255,255,255,.06);
          background: rgba(255,255,255,.025);
        }

        .asi-id-card-course-status {
          width: 4px;
          height: 4px;
          flex-shrink: 0;
          border-radius: 999px;
        }

        .asi-id-card-course-status-active {
          background: #fff;
          box-shadow: 0 0 4px rgba(255,255,255,.35);
        }

        .asi-id-card-course-status-enrolled {
          background: rgba(130,150,210,.45);
        }

        .asi-id-card-course-name {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 8px;
          color: rgba(255,255,255,.45);
        }

        .asi-id-card-course-tag {
          flex-shrink: 0;
          white-space: nowrap;
          border-radius: 3px;
          padding: 1px 4px;
          font-family: "JetBrains Mono", monospace;
          font-size: 6px;
          font-weight: 600;
          letter-spacing: .08em;
          text-transform: uppercase;
        }

        .asi-id-card-course-tag-live {
          color: rgba(255,255,255,.75);
          background: rgba(255,255,255,.04);
          border: 1px solid rgba(255,255,255,.08);
        }

        .asi-id-card-course-tag-enrolled {
          color: rgba(130,150,210,.6);
          background: rgba(130,150,210,.04);
          border: 1px solid rgba(130,150,210,.08);
        }

        .asi-id-card-cross-icon,
        .asi-id-card-rank-icon {
          position: relative;
          display: flex;
          width: 14px;
          height: 14px;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
          border-radius: 3px;
        }

        .asi-id-card-cross-icon {
          border: 1px solid rgba(200,80,80,.15);
          background: rgba(200,80,80,.08);
        }

        .asi-id-card-cross-icon::before,
        .asi-id-card-cross-icon::after {
          content: "";
          position: absolute;
          width: 7px;
          height: 1px;
          border-radius: 1px;
          background: rgba(200,80,80,.6);
        }

        .asi-id-card-cross-icon::before {
          transform: rotate(45deg);
        }

        .asi-id-card-cross-icon::after {
          transform: rotate(-45deg);
        }

        .asi-id-card-rank-icon {
          border: 1px solid rgba(200,180,100,.15);
          background: rgba(200,180,100,.08);
          font-size: 8px;
          color: rgba(200,180,100,.7);
        }

        .asi-id-card-status-text {
          font-size: 8px;
          flex: 1;
        }

        .asi-id-card-status-text-red {
          color: rgba(200,80,80,.5);
        }

        .asi-id-card-status-text-gold {
          color: rgba(200,180,100,.55);
        }

        .asi-id-card-status-sub {
          margin-top: 0;
          font-size: 6.5px;
          color: rgba(255,255,255,.12);
        }

        .asi-id-card-bottom-bar {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 10px;
          margin-top: auto;
          padding-top: 2px;
        }

        .asi-id-card-left-bottom {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .asi-id-card-chip {
          position: relative;
          display: flex;
          width: 26px;
          height: 20px;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          border-radius: 4px;
          border: 1px solid rgba(255,255,255,.05);
          background: linear-gradient(145deg,#1c1c1c,#0e0e0e);
        }

        .asi-id-card-chip::before,
        .asi-id-card-chip::after {
          content: "";
          position: absolute;
          left: 15%;
          right: 15%;
          height: 1px;
        }

        .asi-id-card-chip::before {
          top: 30%;
          background: rgba(255,255,255,.05);
        }

        .asi-id-card-chip::after {
          top: 55%;
          background: rgba(255,255,255,.03);
        }

        .asi-id-card-chip-metal {
          width: 11px;
          height: 11px;
          border-radius: 999px;
          opacity: .35;
          background: linear-gradient(145deg,#aaa,#555,#bbb,#666);
        }

        .asi-id-card-barcode {
          display: flex;
          align-items: flex-end;
          gap: 1px;
          height: 20px;
          opacity: .12;
        }

        .asi-id-card-barcode-bar {
          border-radius: 1px;
          background: #fff;
        }

        .asi-id-card-footer {
          text-align: right;
          line-height: 1.4;
          font-size: 5.5px;
          letter-spacing: .12em;
          text-transform: uppercase;
          color: rgba(255,255,255,.06);
        }

        @media (max-width: 639px) {
          .asi-id-card-course-name {
            white-space: normal;
            line-height: 1.3;
          }

          .asi-id-card-bottom-bar {
            flex-direction: column;
            align-items: flex-start;
          }

          .asi-id-card-footer {
            text-align: left;
          }
        }

        @media (min-width: 640px) {
          .asi-id-card-courses-row {
            grid-template-columns: repeat(4, minmax(0, 1fr));
          }
        }

        @media print {
          .id-card-protected-root {
            display: none !important;
          }

          .id-card-print-warning {
            display: flex !important;
          }
        }
      `}</style>

      <div className="mb-6 rounded-[26px] border border-red-400/30 bg-[linear-gradient(135deg,rgba(120,0,0,0.32),rgba(35,0,0,0.9))] p-5 text-white shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-red-200">Legal Warning</div>
        <p className="mt-3 max-w-4xl text-sm leading-7 text-red-50/92">
          Sharing of this ID card is a violation of Al syed Initiative terms and conditions and may result in account suspension, access revocation, and legal case escalation.
        </p>
        <p className="mt-2 max-w-4xl text-sm leading-7 text-red-100/80">
          This page uses watermarking, right-click blocking, print blocking, and protected-view shielding as deterrents. Browsers cannot guarantee absolute screenshot or screen-recording prevention, so every visible view carries your account identity markers.
        </p>
      </div>

      {dataNotice ? (
        <div className="mb-6 rounded-2xl border border-black panel-gradient px-4 py-3 text-sm text-[#CFCFCF] shadow-[0_14px_32px_rgba(0,0,0,0.24)]">
          {dataNotice}
        </div>
      ) : null}

      <div className="id-card-print-warning hidden min-h-[40vh] items-center justify-center rounded-[28px] border border-red-400/20 bg-black p-8 text-center text-white">
        Printing and static export of this protected credential are disabled.
      </div>

      <div className="space-y-6">
        <section
          ref={matrixShellRef}
          className="id-card-protected-root asi-id-card-shell"
          onContextMenu={(event) => event.preventDefault()}
          onDragStart={(event) => event.preventDefault()}
          onKeyDown={preventSurfaceCaptureShortcuts}
          style={{
            WebkitTouchCallout: "none",
            WebkitUserSelect: "none",
            userSelect: "none",
          }}
          tabIndex={0}
        >
          <div className="asi-id-card-matrix">
            <canvas ref={matrixCanvasRef} />
          </div>
          <div className="asi-id-card-glow asi-id-card-glow-1" />
          <div className="asi-id-card-glow asi-id-card-glow-2" />

          {watermarkLines.map((line) => (
            <div
              key={line.key}
              className="pointer-events-none absolute left-[-10%] right-[-30%] z-[2] overflow-hidden whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.24em] text-white/10"
              style={{ top: line.top, transform: "rotate(-13deg)" }}
            >
              {line.text}
            </div>
          ))}

          {shieldActive ? (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/92 px-6 text-center">
              <div className="max-w-md rounded-[24px] border border-white/10 bg-white/5 px-5 py-6 shadow-[0_20px_60px_rgba(0,0,0,0.38)]">
                <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#CFCFCF]">
                  Protected View Shielded
                </div>
                <p className="mt-3 text-sm leading-7 text-[#E6E6E6]">
                  This identity card is hidden while the page is inactive or being printed.
                </p>
              </div>
            </div>
          ) : null}

          <div className="asi-id-card-card">
            <div className="asi-id-card-stripe" />
            <div className="asi-id-card-corner asi-id-card-corner-tl" />
            <div className="asi-id-card-corner asi-id-card-corner-tr" />
            <div className="asi-id-card-corner asi-id-card-corner-bl" />
            <div className="asi-id-card-corner asi-id-card-corner-br" />

            <div className="asi-id-card-inner">
              <div className="asi-id-card-top-row">
                <div className="asi-id-card-org-label">{idCardLevelLabel}</div>
                <div className="asi-id-card-id-badge">
                  ID: <span>{memberId}</span> // CLR: <span>{clearanceLabel}</span>
                </div>
              </div>

              <div className="asi-id-card-identity-row">
                <div className="asi-id-card-avatar">
                  <img
                    src={profileImageUrl}
                    alt={`${user?.full_name || "User"} profile`}
                    draggable="false"
                  />
                  <div className="asi-id-card-avatar-status" />
                </div>
                <div className="min-w-0">
                  <div className="asi-id-card-handle">{handleLabel}</div>
                  <div className="asi-id-card-display-name">{user?.full_name || userInitials}</div>
                  <div className="asi-id-card-username">
                    uid: <span>{usernameLabel}</span> // active
                  </div>
                </div>
              </div>

              <div className="asi-id-card-divider" />

              <div className="asi-id-card-info-strip">
                <div className="asi-id-card-info-item">
                  <div className="asi-id-card-info-label">Handle</div>
                  <div className="asi-id-card-info-value">{handleLabel}</div>
                </div>
                <div className="asi-id-card-info-item">
                  <div className="asi-id-card-info-label">Username</div>
                  <div className="asi-id-card-info-value">{usernameLabel}</div>
                </div>
                <div className="asi-id-card-info-item">
                  <div className="asi-id-card-info-label">Status</div>
                  <div className="asi-id-card-info-value">
                    <span className="asi-id-card-live-badge">
                      <span className="asi-id-card-live-dot" />
                      ACTIVE
                    </span>
                  </div>
                </div>
                <div className="asi-id-card-info-item">
                  <div className="asi-id-card-info-label">Member Since</div>
                  <div className="asi-id-card-info-value">{joinedLabel}</div>
                </div>
              </div>

              <div className="asi-id-card-divider" />

              <div className="asi-id-card-courses-row">
                <div>
                  <div className="asi-id-card-section-header">
                    <div className="asi-id-card-section-dot" />
                    <div className="asi-id-card-section-title">Live Class</div>
                  </div>
                  <div className="asi-id-card-course-item">
                    <div className="asi-id-card-course-status asi-id-card-course-status-active" />
                    <div className="asi-id-card-course-name">
                      {loading
                        ? "Loading live class..."
                        : primaryLiveClass?.title || "No approved live class"}
                    </div>
                    <div className="asi-id-card-course-tag asi-id-card-course-tag-live">
                      {primaryLiveClass ? "LIVE" : "NONE"}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="asi-id-card-section-header">
                    <div className="asi-id-card-section-dot asi-id-card-section-dot-blue" />
                    <div className="asi-id-card-section-title">Enrolled Course</div>
                  </div>
                  <div className="asi-id-card-course-item">
                    <div className="asi-id-card-course-status asi-id-card-course-status-enrolled" />
                    <div className="asi-id-card-course-name">
                      {loading ? "Loading course..." : primaryCourse?.title || "No course unlocked yet"}
                    </div>
                    <div className="asi-id-card-course-tag asi-id-card-course-tag-enrolled">
                      {primaryCourse ? "ENROLLED" : "LOCKED"}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="asi-id-card-section-header">
                    <div className="asi-id-card-section-dot asi-id-card-section-dot-red" />
                    <div className="asi-id-card-section-title">Al Syed Member</div>
                  </div>
                  <div className="asi-id-card-status-block">
                    <div className="asi-id-card-cross-icon" />
                    <div>
                      <div className="asi-id-card-status-text asi-id-card-status-text-red">
                        {memberVerificationLabel}
                      </div>
                      <div className="asi-id-card-status-sub">{memberVerificationSubLabel}</div>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="asi-id-card-section-header">
                    <div className="asi-id-card-section-dot asi-id-card-section-dot-gold" />
                    <div className="asi-id-card-section-title">Initiative Ranking</div>
                  </div>
                  <div className="asi-id-card-status-block">
                    <div className="asi-id-card-rank-icon">{rankHeading}</div>
                    <div>
                      <div className="asi-id-card-status-text asi-id-card-status-text-gold">
                        {idCardLevelLabel}
                      </div>
                      <div className="asi-id-card-status-sub">{completedCheckpointCount} of 5 checkpoints</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="asi-id-card-bottom-bar">
                <div className="asi-id-card-left-bottom">
                  <div className="asi-id-card-chip">
                    <div className="asi-id-card-chip-metal" />
                  </div>
                  <div className="asi-id-card-barcode">
                    {barcodeBars.map((bar, index) => (
                      <span
                        key={`${bar.width}-${bar.height}-${index}`}
                        className="asi-id-card-barcode-bar"
                        style={{ width: `${bar.width}px`, height: `${bar.height}px` }}
                      />
                    ))}
                  </div>
                </div>
                <div className="asi-id-card-footer">
                  {usernameLabel} // cybersecurity apprentice // {new Date().getFullYear()} // property of al syed initiative
                </div>
              </div>
            </div>

            <div className="asi-id-card-stripe" />
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-3">
          <section className="rounded-[28px] border border-black panel-gradient p-5 shadow-[0_20px_55px_rgba(0,0,0,0.28)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9C9C9C]">
                  Identity Source
                </div>
                <h3 className="mt-2 font-reference text-xl font-semibold text-white">Authenticated Account</h3>
              </div>
              <BrandLogo className="max-w-[220px]" />
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#969696]">User ID</div>
                <div className="mt-2 font-mono text-lg text-white">{user?.id || "n/a"}</div>
              </div>
              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#969696]">Access Class</div>
                <div className="mt-2 text-lg text-white">{roleLabel}</div>
              </div>
              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#969696]">Session Status</div>
                <div className="mt-2 text-lg text-white">Authenticated</div>
              </div>
              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#969696]">Watermark Stamp</div>
                <div className="mt-2 font-mono text-sm text-white">{formatTimestamp(timestamp)}</div>
              </div>
            </div>
          </section>

          <section className="rounded-[28px] border border-black panel-gradient p-5 shadow-[0_20px_55px_rgba(0,0,0,0.28)]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9C9C9C]">Access Footprint</div>
            <h3 className="mt-2 font-reference text-xl font-semibold text-white">Your Current Access</h3>
            <p className="mt-2 text-sm leading-7 text-[#BCBCBC]">
              This summary is generated from your current authenticated user record, paid course enrollments, and approved live-class enrollments.
            </p>

            <div className="mt-4 space-y-3">
              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#969696]">Courses</div>
                <div className="mt-2 text-white">
                  {loading ? "Loading course library..." : `${courses.length} unlocked`}
                </div>
                <div className="mt-2 text-sm text-[#B8B8B8]">
                  {primaryCourse?.title || "No approved or purchased course available yet."}
                </div>
              </div>

              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#969696]">Live Classes</div>
                <div className="mt-2 text-white">
                  {loading ? "Loading live classes..." : `${approvedLiveClasses.length} approved`}
                </div>
                <div className="mt-2 text-sm text-[#B8B8B8]">
                  {primaryLiveClass?.title || "No approved live class linked to this account yet."}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[28px] border border-black panel-gradient p-5 shadow-[0_20px_55px_rgba(0,0,0,0.28)]">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#9C9C9C]">Protection Notice</div>
            <h3 className="mt-2 font-reference text-xl font-semibold text-white">Private Credential Handling</h3>
            <ul className="mt-4 space-y-3 text-sm leading-7 text-[#C9C9C9]">
              <li className="rounded-2xl border border-black panel-gradient px-4 py-3">
                This page is self-only. It renders the authenticated viewer&apos;s details and does not expose another user&apos;s card route.
              </li>
              <li className="rounded-2xl border border-black panel-gradient px-4 py-3">
                Watermarks include your account markers and live timestamp so leaked captures can be traced back to the viewing session.
              </li>
              <li className="rounded-2xl border border-black panel-gradient px-4 py-3">
                Browser protections can deter casual copying, printing, and right-click saving, but they cannot guarantee absolute screenshot or screen-recording prevention.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

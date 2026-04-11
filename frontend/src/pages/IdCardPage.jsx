import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getMyCourses, listLiveClasses } from "../api/courses";
import BrandLogo from "../components/BrandLogo";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiData } from "../utils/api";

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

export default function IdCardPage() {
  const { user } = useAuth();
  const [courses, setCourses] = useState([]);
  const [liveClasses, setLiveClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dataNotice, setDataNotice] = useState("");
  const [shieldActive, setShieldActive] = useState(false);
  const [timestamp, setTimestamp] = useState(() => new Date());

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
  const handleLabel = useMemo(() => deriveHandle(user), [user]);
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

  const profileReadiness = useMemo(() => {
    const hasImage = Boolean(user?.profile_image_url);
    const hasPhone = Boolean(String(user?.phone_number || "").trim());
    const hasName = Boolean(String(user?.full_name || "").trim());
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
  }, [user?.full_name, user?.phone_number, user?.profile_image_url]);

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

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <section
          className="id-card-protected-root relative overflow-hidden rounded-[34px] border border-black panel-gradient p-4 shadow-[0_28px_80px_rgba(0,0,0,0.34)]"
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
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_6%,rgba(255,255,255,0.1),transparent_28%),radial-gradient(circle_at_92%_86%,rgba(187,187,187,0.08),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.025),transparent_42%)]" />
          <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] [background-size:18px_18px]" />
          <div
            className="pointer-events-none absolute -left-[10%] top-0 h-[1px] w-[120%] bg-gradient-to-r from-transparent via-white/45 to-transparent"
            style={{ animation: "idCardSweep 6.2s linear infinite" }}
          />

          {watermarkLines.map((line) => (
            <div
              key={line.key}
              className="pointer-events-none absolute left-[-10%] right-[-30%] z-0 overflow-hidden whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.24em] text-white/10"
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

          <div className="relative z-10 rounded-[28px] border border-white/10 bg-[linear-gradient(160deg,rgba(22,22,22,0.95)_0%,rgba(9,9,9,0.98)_65%,rgba(0,0,0,1)_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] sm:p-6">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#CFCFCF]">
                {roleLabel} Credential
              </div>
              <div className="text-right font-mono text-[11px] uppercase tracking-[0.14em] text-[#8D8D8D]">
                <div>
                  ID: <span className="text-[#D7D7D7]">{memberId}</span>
                </div>
                <div className="mt-1">
                  Role: <span className="text-[#D7D7D7]">{roleLabel}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div
                className="relative flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[20px] border border-white/10 bg-[linear-gradient(145deg,#131313,#060606)] text-3xl font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                style={{ animation: "idCardFloat 6s ease-in-out infinite" }}
              >
                {user?.profile_image_url ? (
                  <img
                    src={user.profile_image_url}
                    alt={`${user?.full_name || "User"} profile`}
                    className="h-full w-full object-cover"
                    draggable="false"
                  />
                ) : (
                  <span>{userInitials}</span>
                )}
                <span
                  className="absolute bottom-2 right-2 h-2.5 w-2.5 rounded-full border border-black bg-white"
                  style={{ animation: "idCardBlink 1.5s ease-in-out infinite" }}
                />
              </div>

              <div className="min-w-0 flex-1">
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#8E8E8E]">{handleLabel}</div>
                <h2 className="mt-2 text-3xl font-black leading-tight text-white">{user?.full_name || "User"}</h2>
                <div className="mt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-[#A5A5A5]">
                  uid: <span className="text-white/80">{user?.id || "n/a"}</span> // active session
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#E1E1E1]">
                    {roleLabel}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#E1E1E1]">
                    Active
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-5 h-px bg-gradient-to-r from-white/10 via-white/5 to-transparent" />

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#848484]">Handle</div>
                <div className="mt-2 break-all font-mono text-sm text-[#EAEAEA]">{handleLabel}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#848484]">Email</div>
                <div className="mt-2 break-all font-mono text-sm text-[#EAEAEA]">{user?.email || "Not available"}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#848484]">Phone</div>
                <div className="mt-2 font-mono text-sm text-[#EAEAEA]">{user?.phone_number || "Not provided"}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#848484]">Member Since</div>
                <div className="mt-2 font-mono text-sm text-[#EAEAEA]">{joinedLabel}</div>
              </div>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <div className="rounded-[22px] border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-white/70" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9A9A9A]">Live Class</span>
                </div>
                <div className="text-base font-semibold text-white">
                  {primaryLiveClass?.title || "No approved live class"}
                </div>
                <div className="mt-2 text-sm leading-6 text-[#AFAFAF]">
                  {primaryLiveClass
                    ? `Month ${primaryLiveClass.month_number} // ${primaryLiveClass.schedule_days}`
                    : "Your live-class approval status will appear here once access is granted."}
                </div>
              </div>

              <div className="rounded-[22px] border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#B7B7B7]" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9A9A9A]">Course Access</span>
                </div>
                <div className="text-base font-semibold text-white">
                  {primaryCourse?.title || "No course unlocked yet"}
                </div>
                <div className="mt-2 text-sm leading-6 text-[#AFAFAF]">
                  {primaryCourse
                    ? `${primaryCourse.access_label || "Unlocked"} // ${courses.length} total in your library`
                    : "Purchased or approved courses will appear here automatically."}
                </div>
              </div>

              <div className="rounded-[22px] border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${profileReadiness.accent}`} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9A9A9A]">Profile Status</span>
                </div>
                <div className={`text-base font-semibold ${profileReadiness.tone}`}>{profileReadiness.label}</div>
                <div className="mt-2 text-sm leading-6 text-[#AFAFAF]">{profileReadiness.sublabel}</div>
              </div>

              <div className="rounded-[22px] border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#EAEAEA]" />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9A9A9A]">Security</span>
                </div>
                <div className={`text-base font-semibold ${securitySummary.tone}`}>{securitySummary.label}</div>
                <div className="mt-2 text-sm leading-6 text-[#AFAFAF]">{securitySummary.sublabel}</div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-end justify-between gap-4 border-t border-white/10 pt-5">
              <div className="flex items-end gap-4">
                <div className="flex h-12 w-14 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                  <div className="h-6 w-6 rounded-full bg-gradient-to-br from-[#B9B9B9] via-[#5E5E5E] to-[#D8D8D8] opacity-45" />
                </div>
                <div className="flex h-12 items-end gap-[2px] opacity-50">
                  {barcodeBars.map((bar, index) => (
                    <span
                      key={`${bar.width}-${bar.height}-${index}`}
                      className="rounded-sm bg-white"
                      style={{ width: `${bar.width}px`, height: `${bar.height}px` }}
                    />
                  ))}
                </div>
              </div>

              <div className="max-w-sm text-right font-mono text-[10px] uppercase tracking-[0.18em] text-[#6F6F6F]">
                <div>{accessSummary}</div>
                <div className="mt-1">property of al syed initiative // private credential</div>
              </div>
            </div>
          </div>
        </section>

        <div className="space-y-6">
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

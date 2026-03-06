import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { changePassword, disableTwoFactor, enableTwoFactor, setupTwoFactor, updateProfile } from "../api/auth";
import Button from "../components/Button";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";

function StatusText({ error, success }) {
  if (error) {
    return (
      <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-200">
        {error}
      </div>
    );
  }
  if (success) {
    return (
      <div className="mt-3 rounded-xl border border-green-500/30 bg-green-500/10 px-3.5 py-2.5 text-sm text-green-200">
        {success}
      </div>
    );
  }
  return null;
}

export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const [profileName, setProfileName] = useState("");
  const [profileImageFile, setProfileImageFile] = useState(null);
  const [profilePreview, setProfilePreview] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileStatus, setProfileStatus] = useState({ error: "", success: "" });

  const [passwordForm, setPasswordForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
  });
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState({ error: "", success: "" });

  const [twoFASetup, setTwoFASetup] = useState(null);
  const [twoFACode, setTwoFACode] = useState("");
  const [twoFADisablePassword, setTwoFADisablePassword] = useState("");
  const [twoFALoading, setTwoFALoading] = useState(false);
  const [twoFAStatus, setTwoFAStatus] = useState({ error: "", success: "" });
  const [twoFAQrDataUrl, setTwoFAQrDataUrl] = useState("");

  useEffect(() => {
    setProfileName(user?.full_name || "");
    setProfilePreview(user?.profile_image_url || "");
  }, [user?.full_name, user?.profile_image_url]);

  const effectivePreview = useMemo(() => {
    if (profileImageFile) {
      return URL.createObjectURL(profileImageFile);
    }
    return profilePreview;
  }, [profileImageFile, profilePreview]);

  useEffect(() => {
    return () => {
      if (profileImageFile) {
        URL.revokeObjectURL(effectivePreview);
      }
    };
  }, [effectivePreview, profileImageFile]);

  useEffect(() => {
    let cancelled = false;

    async function buildQr() {
      const otpUri = twoFASetup?.otp_uri;
      if (!otpUri) {
        setTwoFAQrDataUrl("");
        return;
      }
      try {
        const dataUrl = await QRCode.toDataURL(otpUri, {
          width: 220,
          margin: 1,
          errorCorrectionLevel: "M",
          color: {
            dark: "#0d120f",
            light: "#eef3e800",
          },
        });
        if (!cancelled) {
          setTwoFAQrDataUrl(dataUrl);
        }
      } catch {
        if (!cancelled) {
          setTwoFAQrDataUrl("");
        }
      }
    }

    buildQr();
    return () => {
      cancelled = true;
    };
  }, [twoFASetup?.otp_uri]);

  const userInitial = useMemo(
    () => (user?.full_name || user?.email || "U").charAt(0).toUpperCase(),
    [user?.email, user?.full_name]
  );

  const accountRoleLabel = useMemo(() => {
    if (user?.is_admin) {
      return "Administrator";
    }
    if (user?.role === "instructor") {
      return "Instructor";
    }
    return "Student";
  }, [user?.is_admin, user?.role]);

  const profileCompletion = useMemo(() => {
    let score = 0;
    if (user?.full_name) score += 40;
    if (user?.email) score += 30;
    if (user?.profile_image_url || profileImageFile) score += 30;
    return score;
  }, [profileImageFile, user?.email, user?.full_name, user?.profile_image_url]);

  const joinedLabel = useMemo(() => {
    if (!user?.created_at) {
      return "N/A";
    }
    const date = new Date(user.created_at);
    if (Number.isNaN(date.getTime())) {
      return "N/A";
    }
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }, [user?.created_at]);

  const handleProfileSave = async (e) => {
    e.preventDefault();
    setProfileLoading(true);
    setProfileStatus({ error: "", success: "" });
    try {
      const formData = new FormData();
      formData.append("full_name", profileName);
      if (profileImageFile) {
        formData.append("profile_image", profileImageFile);
      }
      await updateProfile(formData);
      await refreshUser();
      setProfileImageFile(null);
      setProfileStatus({ error: "", success: "Profile updated." });
    } catch (err) {
      setProfileStatus({ error: apiMessage(err, "Unable to update profile."), success: "" });
    } finally {
      setProfileLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPasswordStatus({ error: "", success: "" });
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordStatus({ error: "New password and confirm password do not match.", success: "" });
      return;
    }
    setPasswordLoading(true);
    try {
      await changePassword({
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });
      setPasswordForm({ current_password: "", new_password: "", confirm_password: "" });
      await refreshUser();
      setPasswordStatus({ error: "", success: "Password changed successfully." });
    } catch (err) {
      setPasswordStatus({ error: apiMessage(err, "Unable to change password."), success: "" });
    } finally {
      setPasswordLoading(false);
    }
  };

  const handle2FASetup = async () => {
    setTwoFALoading(true);
    setTwoFAStatus({ error: "", success: "" });
    try {
      const response = await setupTwoFactor();
      setTwoFASetup(apiData(response, null));
      setTwoFAStatus({
        error: "",
        success: "2FA secret generated. Add it to your authenticator app, then verify with a code.",
      });
    } catch (err) {
      setTwoFAStatus({ error: apiMessage(err, "Unable to start 2FA setup."), success: "" });
    } finally {
      setTwoFALoading(false);
    }
  };

  const handle2FAEnable = async (e) => {
    e.preventDefault();
    setTwoFALoading(true);
    setTwoFAStatus({ error: "", success: "" });
    try {
      await enableTwoFactor({ code: twoFACode.trim() });
      setTwoFACode("");
      await refreshUser();
      setTwoFAStatus({ error: "", success: "Two-factor authentication enabled." });
    } catch (err) {
      setTwoFAStatus({ error: apiMessage(err, "Unable to enable 2FA."), success: "" });
    } finally {
      setTwoFALoading(false);
    }
  };

  const handle2FADisable = async (e) => {
    e.preventDefault();
    setTwoFALoading(true);
    setTwoFAStatus({ error: "", success: "" });
    try {
      await disableTwoFactor({ password: twoFADisablePassword });
      setTwoFADisablePassword("");
      setTwoFASetup(null);
      setTwoFAQrDataUrl("");
      await refreshUser();
      setTwoFAStatus({ error: "", success: "Two-factor authentication disabled." });
    } catch (err) {
      setTwoFAStatus({ error: apiMessage(err, "Unable to disable 2FA."), success: "" });
    } finally {
      setTwoFALoading(false);
    }
  };

  return (
    <PageShell
      title="Profile"
      subtitle="Manage your profile image, display name, password, and account security."
    >
      <section className="relative overflow-hidden rounded-3xl border border-[#cdd8c3]/15 bg-[#0b100c]/92 p-5 shadow-[0_22px_60px_rgba(0,0,0,0.34)] sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_10%,rgba(183,201,170,0.22),transparent_35%),radial-gradient(circle_at_88%_84%,rgba(139,165,145,0.18),transparent_33%)]" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-20 w-20 overflow-hidden rounded-2xl border border-[#344037] bg-[#121813] shadow-[0_12px_24px_rgba(0,0,0,0.32)]">
              {effectivePreview ? (
                <img src={effectivePreview} alt="Profile preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-[#d7e0cd]">
                  {userInitial}
                </div>
              )}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#9ca895]">
                Account Identity
              </p>
              <h2 className="mt-1 text-2xl font-semibold text-white">{user?.full_name || "User"}</h2>
              <p className="mt-1 text-sm text-[#b7c0b0]">{user?.email || "-"}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-[#2d3830] bg-[#111712]/90 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#919c8b]">Role</div>
              <div className="mt-1 text-sm font-semibold text-[#dce5d2]">{accountRoleLabel}</div>
            </div>
            <div className="rounded-xl border border-[#2d3830] bg-[#111712]/90 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#919c8b]">2FA</div>
              <div className="mt-1 text-sm font-semibold text-[#dce5d2]">
                {user?.two_factor_enabled ? "Enabled" : "Disabled"}
              </div>
            </div>
            <div className="rounded-xl border border-[#2d3830] bg-[#111712]/90 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#919c8b]">Member Since</div>
              <div className="mt-1 text-sm font-semibold text-[#dce5d2]">{joinedLabel}</div>
            </div>
          </div>
        </div>

        <div className="relative mt-5">
          <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-[#96a18f]">
            <span>Profile completion</span>
            <span>{profileCompletion}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#1a241d]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#d8e1cd] via-[#b9c8ac] to-[#8ea384] shadow-[0_0_18px_rgba(178,198,164,0.45)]"
              style={{ width: `${profileCompletion}%` }}
            />
          </div>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.08fr_0.92fr]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-[#253026] bg-[#0b100c]/90 p-5 shadow-[0_14px_40px_rgba(0,0,0,0.28)] sm:p-6">
            <div className="mb-5">
              <h2 className="font-reference text-xl font-semibold text-white">Profile Details</h2>
              <p className="mt-1.5 text-sm text-[#aeb8a7]">
                Update your display name and profile picture shown across your account.
              </p>
            </div>

            <form onSubmit={handleProfileSave} className="space-y-4">
              <div className="rounded-2xl border border-[#273127] bg-[#111813]/86 p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <div className="h-24 w-24 overflow-hidden rounded-2xl border border-[#334034] bg-[#161f17] shadow-[0_10px_20px_rgba(0,0,0,0.28)]">
                    {effectivePreview ? (
                      <img src={effectivePreview} alt="Profile preview" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-[#d5dfca]">
                        {userInitial}
                      </div>
                    )}
                  </div>
                  <label className="block flex-1">
                    <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#aeb8a3]">
                      Profile Picture
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => setProfileImageFile(e.target.files?.[0] || null)}
                      className="block w-full rounded-xl border border-[#2a332d] bg-[#0f1310] px-3 py-2 text-sm text-[#d7dfcd] file:mr-3 file:rounded-lg file:border-0 file:bg-[#d7e1cc] file:px-3 file:py-2 file:text-xs file:font-semibold file:uppercase file:tracking-[0.1em] file:text-[#101410] hover:file:bg-[#e4ecdc]"
                    />
                    <span className="mt-2 block text-xs text-[#889486]">
                      Recommended: square image, PNG/JPG, under 2MB.
                    </span>
                  </label>
                </div>
              </div>

              <FormInput
                label="Username (Display Name)"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                required
              />

              <FormInput label="Email (Login)" value={user?.email || ""} disabled />

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={profileLoading}>
                  Save Profile
                </Button>
                <span className="text-xs uppercase tracking-[0.12em] text-[#8b9785]">
                  Changes apply immediately
                </span>
              </div>
              <StatusText {...profileStatus} />
            </form>
          </section>

          <section className="rounded-2xl border border-[#253026] bg-[#0b100c]/90 p-5 shadow-[0_14px_40px_rgba(0,0,0,0.28)] sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-reference text-xl font-semibold text-white">Two-Factor Authentication</h2>
                <p className="mt-1.5 text-sm text-[#aeb8a7]">
                  Add a second authentication layer for stronger account protection.
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  user?.two_factor_enabled
                    ? "border border-green-300/30 bg-green-300/10 text-green-200"
                    : "border border-[#2a332d] bg-[#111612] text-[#c0cab7]"
                }`}
              >
                {user?.two_factor_enabled ? "Enabled" : "Disabled"}
              </span>
            </div>

            {!user?.two_factor_enabled ? (
              <div className="mt-5 space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-[#273227] bg-[#101710]/86 px-3 py-2.5 text-xs text-[#b0baa8]">
                    1. Generate secret
                  </div>
                  <div className="rounded-xl border border-[#273227] bg-[#101710]/86 px-3 py-2.5 text-xs text-[#b0baa8]">
                    2. Scan QR code
                  </div>
                  <div className="rounded-xl border border-[#273227] bg-[#101710]/86 px-3 py-2.5 text-xs text-[#b0baa8]">
                    3. Verify OTP code
                  </div>
                </div>

                <Button type="button" variant="secondary" onClick={handle2FASetup} loading={twoFALoading}>
                  Generate 2FA Secret
                </Button>

                {twoFASetup ? (
                  <div className="rounded-xl border border-[#233024] bg-[#0f1510] p-4 text-sm text-[#c6cfbd]">
                    <p className="text-xs uppercase tracking-[0.14em] text-[#8f9989]">Authenticator Setup</p>
                    <p className="mt-2">Scan this QR in Google Authenticator or Microsoft Authenticator.</p>
                    <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start">
                      <div className="rounded-xl border border-[#2a332d] bg-white p-2">
                        {twoFAQrDataUrl ? (
                          <img
                            src={twoFAQrDataUrl}
                            alt="2FA setup QR code"
                            className="h-[180px] w-[180px] rounded-md object-contain"
                          />
                        ) : (
                          <div className="flex h-[180px] w-[180px] items-center justify-center text-xs text-[#334033]">
                            QR unavailable
                          </div>
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="text-xs text-[#a2ad9b]">
                          If scanning is unavailable, use the manual setup key.
                        </p>
                        <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[#8f9989]">Setup Key</p>
                        <code className="mt-1 block overflow-x-auto rounded-lg bg-black/40 px-3 py-2 text-xs text-[#dfe6d5]">
                          {twoFASetup.secret}
                        </code>
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-[#a2ad9b]">OTP URI (advanced/manual import):</p>
                    <code className="mt-1 block max-h-24 overflow-auto rounded-lg bg-black/40 px-3 py-2 text-[11px] text-[#cfd8c5]">
                      {twoFASetup.otp_uri}
                    </code>
                  </div>
                ) : null}

                <form onSubmit={handle2FAEnable} className="space-y-3">
                  <FormInput
                    label="Authenticator Code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    value={twoFACode}
                    onChange={(e) => setTwoFACode(e.target.value.replace(/\s+/g, ""))}
                    required
                  />
                  <Button type="submit" loading={twoFALoading}>
                    Enable 2FA
                  </Button>
                </form>
              </div>
            ) : (
              <form onSubmit={handle2FADisable} className="mt-5 space-y-3">
                <p className="text-sm text-[#b8c2b0]">
                  Two-factor authentication is active. Enter current password to disable it.
                </p>
                <FormInput
                  label="Current Password"
                  type="password"
                  value={twoFADisablePassword}
                  onChange={(e) => setTwoFADisablePassword(e.target.value)}
                  required
                />
                <Button type="submit" variant="danger" loading={twoFALoading}>
                  Disable 2FA
                </Button>
              </form>
            )}

            <StatusText {...twoFAStatus} />
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-2xl border border-[#253026] bg-[#0b100c]/90 p-5 shadow-[0_14px_40px_rgba(0,0,0,0.28)] sm:p-6">
            <div className="mb-4">
              <h2 className="font-reference text-xl font-semibold text-white">Change Password</h2>
              <p className="mt-1.5 text-sm text-[#aeb8a7]">
                Use a strong password and rotate it periodically to keep your account secure.
              </p>
            </div>
            <form onSubmit={handlePasswordChange} className="space-y-4">
              <FormInput
                label="Current Password"
                type="password"
                value={passwordForm.current_password}
                onChange={(e) =>
                  setPasswordForm((prev) => ({ ...prev, current_password: e.target.value }))
                }
                required
              />
              <FormInput
                label="New Password"
                type="password"
                value={passwordForm.new_password}
                onChange={(e) =>
                  setPasswordForm((prev) => ({ ...prev, new_password: e.target.value }))
                }
                required
              />
              <FormInput
                label="Confirm New Password"
                type="password"
                value={passwordForm.confirm_password}
                onChange={(e) =>
                  setPasswordForm((prev) => ({ ...prev, confirm_password: e.target.value }))
                }
                required
              />
              <Button type="submit" loading={passwordLoading}>
                Update Password
              </Button>
              <StatusText {...passwordStatus} />
            </form>
          </section>

          <section className="rounded-2xl border border-[#253026] bg-[#0b100c]/90 p-5 shadow-[0_14px_40px_rgba(0,0,0,0.28)] sm:p-6">
            <h3 className="font-reference text-lg font-semibold text-white">Security Brief</h3>
            <p className="mt-2 text-sm text-[#aeb8a7]">
              Operational recommendations for enterprise-grade account hygiene.
            </p>
            <ul className="mt-4 space-y-2.5 text-sm text-[#c3ccb9]">
              <li className="rounded-lg border border-[#273227] bg-[#101710]/86 px-3 py-2.5">
                Use a unique password that is not reused on other services.
              </li>
              <li className="rounded-lg border border-[#273227] bg-[#101710]/86 px-3 py-2.5">
                Keep two-factor authentication enabled for all privileged accounts.
              </li>
              <li className="rounded-lg border border-[#273227] bg-[#101710]/86 px-3 py-2.5">
                Avoid sharing session devices and always log out on shared systems.
              </li>
              <li className="rounded-lg border border-[#273227] bg-[#101710]/86 px-3 py-2.5">
                Rotate credentials immediately after suspected account exposure.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

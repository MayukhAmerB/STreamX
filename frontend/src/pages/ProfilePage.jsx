import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { changePassword, disableTwoFactor, enableTwoFactor, setupTwoFactor, updateProfile } from "../api/auth";
import Button from "../components/Button";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";

function StatusText({ error, success }) {
  if (error) return <p className="mt-2 text-sm text-red-300">{error}</p>;
  if (success) return <p className="mt-2 text-sm text-green-300">{success}</p>;
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
      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-2xl border border-[#253026] bg-[#0b100c]/90 p-5 shadow-[0_14px_40px_rgba(0,0,0,0.25)]">
          <h2 className="font-reference text-lg font-semibold text-white">Profile Details</h2>
          <p className="mt-1 text-sm text-[#aeb8a7]">
            Login uses your email. You can update your display name (shown as username in the app) and profile image here.
          </p>

          <form onSubmit={handleProfileSave} className="mt-5 space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="h-20 w-20 overflow-hidden rounded-2xl border border-[#2a332d] bg-[#111612]">
                {effectivePreview ? (
                  <img src={effectivePreview} alt="Profile preview" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-[#c5d0bc]">
                    {(user?.full_name || user?.email || "U").charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="flex-1">
                <FormInput
                  label="Profile Picture"
                  type="file"
                  accept="image/*"
                  onChange={(e) => setProfileImageFile(e.target.files?.[0] || null)}
                />
              </div>
            </div>

            <FormInput
              label="Username (Display Name)"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              required
            />

            <FormInput label="Email (Login)" value={user?.email || ""} disabled />

            <Button type="submit" loading={profileLoading}>
              Save Profile
            </Button>
            <StatusText {...profileStatus} />
          </form>
        </section>

        <section className="space-y-6">
          <div className="rounded-2xl border border-[#253026] bg-[#0b100c]/90 p-5 shadow-[0_14px_40px_rgba(0,0,0,0.25)]">
            <h2 className="font-reference text-lg font-semibold text-white">Change Password</h2>
            <form onSubmit={handlePasswordChange} className="mt-4 space-y-4">
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
          </div>

          <div className="rounded-2xl border border-[#253026] bg-[#0b100c]/90 p-5 shadow-[0_14px_40px_rgba(0,0,0,0.25)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-reference text-lg font-semibold text-white">Two-Factor Authentication</h2>
                <p className="mt-1 text-sm text-[#aeb8a7]">
                  Protect your account with an authenticator app code during login.
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
              <div className="mt-4 space-y-4">
                <Button type="button" variant="secondary" onClick={handle2FASetup} loading={twoFALoading}>
                  Generate 2FA Secret
                </Button>

                {twoFASetup ? (
                  <div className="rounded-xl border border-[#233024] bg-[#0f1510] p-4 text-sm text-[#c6cfbd]">
                    <p className="text-xs uppercase tracking-[0.14em] text-[#8f9989]">Authenticator setup</p>
                    <p className="mt-2">Scan this QR in Google Authenticator / Microsoft Authenticator:</p>
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
                          If scanning is not available, use the manual setup key below.
                        </p>
                        <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[#8f9989]">
                          Setup Key
                        </p>
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
              <form onSubmit={handle2FADisable} className="mt-4 space-y-3">
                <p className="text-sm text-[#b8c2b0]">
                  To disable 2FA, confirm your current password.
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
          </div>
        </section>
      </div>
    </PageShell>
  );
}

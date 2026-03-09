import { useEffect, useMemo, useState } from "react";
import { updateProfile } from "../api/auth";
import Button from "../components/Button";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiMessage } from "../utils/api";

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
      <div className="mt-3 rounded-xl border border-zinc-500/30 bg-zinc-500/10 px-3.5 py-2.5 text-sm text-zinc-200">
        {success}
      </div>
    );
  }
  return null;
}

export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const [profileName, setProfileName] = useState("");
  const [profilePhone, setProfilePhone] = useState("");
  const [profileImageFile, setProfileImageFile] = useState(null);
  const [profilePreview, setProfilePreview] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileStatus, setProfileStatus] = useState({ error: "", success: "" });

  useEffect(() => {
    setProfileName(user?.full_name || "");
    setProfilePhone(user?.phone_number || "");
    setProfilePreview(user?.profile_image_url || "");
  }, [user?.full_name, user?.phone_number, user?.profile_image_url]);

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
      formData.append("phone_number", profilePhone);
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

  return (
    <PageShell
      title="Profile"
      subtitle="Manage your profile image and display name. Credential controls are currently managed by admin."
    >
      <section className="relative overflow-hidden rounded-3xl border border-black panel-gradient p-5 shadow-[0_22px_60px_rgba(0,0,0,0.34)] sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_10%,rgba(192,192,192,0.22),transparent_35%),radial-gradient(circle_at_88%_84%,rgba(155,155,155,0.18),transparent_33%)]" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="h-20 w-20 overflow-hidden rounded-2xl border border-black bg-[#161616] shadow-[0_12px_24px_rgba(0,0,0,0.32)]">
              {effectivePreview ? (
                <img src={effectivePreview} alt="Profile preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-[#DBDBDB]">
                  {userInitial}
                </div>
              )}
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#A2A2A2]">
                Account Identity
              </p>
              <h2 className="mt-1 text-2xl font-semibold text-white">{user?.full_name || "User"}</h2>
              <p className="mt-1 text-sm text-[#BBBBBB]">{user?.email || "-"}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-black panel-gradient px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#979797]">Role</div>
              <div className="mt-1 text-sm font-semibold text-[#E0E0E0]">{accountRoleLabel}</div>
            </div>
            <div className="rounded-xl border border-black panel-gradient px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#979797]">
                Credential Policy
              </div>
              <div className="mt-1 text-sm font-semibold text-[#E0E0E0]">Admin-managed</div>
            </div>
            <div className="rounded-xl border border-black panel-gradient px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#979797]">Member Since</div>
              <div className="mt-1 text-sm font-semibold text-[#E0E0E0]">{joinedLabel}</div>
            </div>
          </div>
        </div>

        <div className="relative mt-5">
          <div className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-[#9C9C9C]">
            <span>Profile completion</span>
            <span>{profileCompletion}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#202020]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#DCDCDC] via-[#C0C0C0] to-[#999999] shadow-[0_0_18px_rgba(188,188,188,0.45)]"
              style={{ width: `${profileCompletion}%` }}
            />
          </div>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.08fr_0.92fr]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-black panel-gradient p-5 shadow-[0_14px_40px_rgba(0,0,0,0.28)] sm:p-6">
            <div className="mb-5">
              <h2 className="font-reference text-xl font-semibold text-white">Profile Details</h2>
              <p className="mt-1.5 text-sm text-[#B3B3B3]">
                Update your display name and profile picture shown across your account.
              </p>
            </div>

            <form onSubmit={handleProfileSave} className="space-y-4">
              <div className="rounded-2xl border border-black panel-gradient p-4">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <div className="h-24 w-24 overflow-hidden rounded-2xl border border-black bg-[#1B1B1B] shadow-[0_10px_20px_rgba(0,0,0,0.28)]">
                    {effectivePreview ? (
                      <img src={effectivePreview} alt="Profile preview" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-3xl font-semibold text-[#DADADA]">
                        {userInitial}
                      </div>
                    )}
                  </div>
                  <label className="block flex-1">
                    <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#B3B3B3]">
                      Profile Picture
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => setProfileImageFile(e.target.files?.[0] || null)}
                      className="block w-full rounded-xl border border-black bg-[#111111] px-3 py-2 text-sm text-[#DBDBDB] file:mr-3 file:rounded-lg file:border-0 file:bg-[#DCDCDC] file:px-3 file:py-2 file:text-xs file:font-semibold file:uppercase file:tracking-[0.1em] file:text-[#121212] hover:file:bg-[#E8E8E8]"
                    />
                    <span className="mt-2 block text-xs text-[#8F8F8F]">
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

              <FormInput
                label="Phone Number"
                value={profilePhone}
                onChange={(e) => setProfilePhone(e.target.value)}
                placeholder="+91 98765 43210"
                required
              />

              <FormInput label="Email (Login)" value={user?.email || ""} disabled />

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={profileLoading}>
                  Save Profile
                </Button>
                <span className="text-xs uppercase tracking-[0.12em] text-[#919191]">
                  Changes apply immediately
                </span>
              </div>
              <StatusText {...profileStatus} />
            </form>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-2xl border border-black panel-gradient p-5 shadow-[0_14px_40px_rgba(0,0,0,0.28)] sm:p-6">
            <h2 className="font-reference text-xl font-semibold text-white">Credentials Managed by Admin</h2>
            <p className="mt-2 text-sm text-[#BBBBBB]">
              Password change and two-factor setup are temporarily disabled for users. Contact admin
              for credential updates and authentication changes.
            </p>
            <div className="mt-4 rounded-xl border border-black bg-[#161616]/88 p-4 text-sm text-[#D4D4D4]">
              <p className="font-semibold text-[#E6E6E6]">Current policy</p>
              <ul className="mt-2 space-y-2 text-[#C9C9C9]">
                <li>Passwords are provisioned by admin only.</li>
                <li>Two-factor authentication enrollment is admin controlled.</li>
                <li>For access issues, raise a support request with admin.</li>
              </ul>
            </div>
          </section>

          <section className="rounded-2xl border border-black panel-gradient p-5 shadow-[0_14px_40px_rgba(0,0,0,0.28)] sm:p-6">
            <h3 className="font-reference text-lg font-semibold text-white">Security Brief</h3>
            <p className="mt-2 text-sm text-[#B3B3B3]">
              Operational recommendations for enterprise-grade account hygiene.
            </p>
            <ul className="mt-4 space-y-2.5 text-sm text-[#C7C7C7]">
              <li className="rounded-lg border border-black panel-gradient px-3 py-2.5">
                Use only approved organization devices for platform access.
              </li>
              <li className="rounded-lg border border-black panel-gradient px-3 py-2.5">
                Report suspicious account activity to admin immediately.
              </li>
              <li className="rounded-lg border border-black panel-gradient px-3 py-2.5">
                Never share credentials over email, chat, or screenshots.
              </li>
              <li className="rounded-lg border border-black panel-gradient px-3 py-2.5">
                Follow admin-issued credential rotation windows.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

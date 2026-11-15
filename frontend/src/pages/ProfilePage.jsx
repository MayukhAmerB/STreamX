import "./ProfilePage.scss";

import { Camera, Identification, Save } from "@carbon/icons-react";
import { Button, InlineLoading, Stack, Tag, TextInput, Tile } from "@carbon/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { updateProfile } from "../api/auth";
import UserAvatar from "../features/app-shell/UserAvatar";
import { PageHeader, PageNotification, useToast } from "../features/app-shell/ui";
import { useAuth } from "../hooks/useAuth";
import { apiMessage } from "../utils/api";

export const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;

export function getAccountRoleLabel(user) {
  if (user?.is_admin) return "Administrator";
  if (user?.role === "instructor") return "Instructor";
  return "Student";
}

export function formatMemberSince(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

/** Presentational profile view (used directly by tests and the visual harness). */
export function ProfileView({
  user,
  name,
  phone,
  previewUrl,
  saving,
  error,
  dirty,
  onNameChange,
  onPhoneChange,
  onPhotoSelect,
  onSubmit,
}) {
  const fileInputRef = useRef(null);
  const fileInputId = useId();
  const memberSince = formatMemberSince(user?.created_at);

  return (
    <>
      <PageHeader
        title="Profile"
        description="Your photo, name and phone number."
        actions={
          <Button as={Link} to="/id-card" kind="tertiary" renderIcon={Identification}>
            ID card
          </Button>
        }
      />

      <div className="cds-profile-layout">
        <Tile className="cds-profile-identity">
          <UserAvatar user={user} src={previewUrl || undefined} size="xl" />
          <div className="cds-profile-identity__text">
            <p className="cds-profile-identity__name">{user?.full_name || "Your name"}</p>
            <p className="cds-profile-identity__email">{user?.email || ""}</p>
            <div className="cds-profile-identity__tags">
              <Tag type="blue" size="sm">
                {getAccountRoleLabel(user)}
              </Tag>
              {memberSince ? (
                <Tag type="gray" size="sm">
                  Since {memberSince}
                </Tag>
              ) : null}
            </div>
          </div>
          <input
            ref={fileInputRef}
            id={fileInputId}
            className="cds--visually-hidden"
            type="file"
            accept="image/*"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => onPhotoSelect(event.target.files?.[0] || null)}
          />
          <Button
            kind="tertiary"
            size="md"
            renderIcon={Camera}
            className="cds-profile-identity__photo"
            onClick={() => fileInputRef.current?.click()}
          >
            Change photo
          </Button>
        </Tile>

        <Tile className="cds-profile-form-tile">
          <form onSubmit={onSubmit} noValidate={false}>
            <Stack gap={6}>
              <TextInput
                id="profile-name"
                labelText="Name"
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
                autoComplete="name"
                required
                size="lg"
              />
              <TextInput
                id="profile-phone"
                labelText="Phone"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(event) => onPhoneChange(event.target.value)}
                autoComplete="tel"
                placeholder="+91 98765 43210"
                required
                size="lg"
              />
              <TextInput
                id="profile-email"
                labelText="Email"
                helperText="Used to sign in. Ask your admin to change it."
                value={user?.email || ""}
                readOnly
                size="lg"
              />
              {error ? <PageNotification kind="error" title="Not saved." subtitle={error} /> : null}
              <div className="cds-profile-form__actions">
                {saving ? (
                  <InlineLoading description="Saving..." />
                ) : (
                  <Button type="submit" renderIcon={Save} disabled={!dirty}>
                    Save
                  </Button>
                )}
              </div>
            </Stack>
          </form>
        </Tile>

        <PageNotification
          kind="info"
          title="Password and 2-step sign-in"
          subtitle="are managed by your admin."
        />
      </div>
    </>
  );
}

export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const { showToast } = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setName(user?.full_name || "");
    setPhone(user?.phone_number || "");
  }, [user?.full_name, user?.phone_number]);

  const filePreview = useMemo(() => (imageFile ? URL.createObjectURL(imageFile) : ""), [imageFile]);
  useEffect(() => () => {
    if (filePreview) URL.revokeObjectURL(filePreview);
  }, [filePreview]);

  const dirty =
    Boolean(imageFile) ||
    name.trim() !== String(user?.full_name || "").trim() ||
    phone.trim() !== String(user?.phone_number || "").trim();

  const handlePhotoSelect = (file) => {
    setError("");
    if (file && file.size > MAX_PROFILE_IMAGE_BYTES) {
      setError("Choose a photo under 2 MB.");
      return;
    }
    setImageFile(file);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("full_name", name);
      formData.append("phone_number", phone);
      if (imageFile) formData.append("profile_image", imageFile);
      await updateProfile(formData);
      await refreshUser();
      setImageFile(null);
      showToast({ kind: "success", title: "Profile saved" });
    } catch (err) {
      setError(apiMessage(err, "Unable to update profile."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProfileView
      user={user}
      name={name}
      phone={phone}
      previewUrl={filePreview}
      saving={saving}
      error={error}
      dirty={dirty}
      onNameChange={setName}
      onPhoneChange={setPhone}
      onPhotoSelect={handlePhotoSelect}
      onSubmit={handleSubmit}
    />
  );
}

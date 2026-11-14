import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { confirmPasswordReset } from "../../api/auth";
import { apiMessage } from "../../utils/api";
import { AuthField, AuthMessage, AuthSubmit } from "./AuthControls";
import AuthSplit from "./AuthSplit";

export const MIN_PASSWORD_LENGTH = 8;

/** The uid/token pair from the e-mailed link (`/reset-password?uid=…&token=…`). */
export function readResetLink(search) {
  try {
    const params = new URLSearchParams(search || "");
    const uid = String(params.get("uid") || "").trim();
    const token = String(params.get("token") || "").trim();
    return uid && token ? { uid, token } : null;
  } catch {
    return null;
  }
}

/** Client-side checks before the server's password validators run. */
export function validateNewPassword(password, confirm) {
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    return { field: "password", message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password !== confirm) {
    return { field: "confirm", message: "The two passwords do not match." };
  }
  return null;
}

function serverPasswordError(err) {
  const errors = err?.response?.data?.errors;
  const fieldErrors = errors?.new_password;
  if (Array.isArray(fieldErrors) && fieldErrors.length) return fieldErrors.join(" ");
  if (typeof fieldErrors === "string") return fieldErrors;
  return "";
}

/**
 * Set a new password from the e-mailed reset link (T-AUTH split screen).
 * POST /api/auth/password-reset-confirm/ { uid, token, new_password }.
 */
export default function ResetPasswordPage() {
  const location = useLocation();
  const link = readResetLink(location.search);
  const [form, setForm] = useState({ password: "", confirm: "" });
  const [fieldError, setFieldError] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const change = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setFieldError(null);
    setError("");
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!link) return;
    const problem = validateNewPassword(form.password, form.confirm);
    if (problem) {
      setFieldError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await confirmPasswordReset({ uid: link.uid, token: link.token, new_password: form.password });
      setDone(true);
      setForm({ password: "", confirm: "" });
    } catch (err) {
      const passwordProblem = serverPasswordError(err);
      if (passwordProblem) setFieldError({ field: "password", message: passwordProblem });
      else setError(err?.response?.data?.errors?.detail || apiMessage(err, "This reset link could not be used."));
    } finally {
      setBusy(false);
    }
  };

  const corner = (
    <Link to="/login" className="au-corner">
      Sign in
    </Link>
  );

  let title = "Choose a new password";
  let sub = "Set the password you will use to sign in from now on.";
  if (!link) {
    title = "Reset link incomplete";
    sub = "Open the full link from your e-mail, or ask for a new one from the sign-in page.";
  } else if (done) {
    title = "Password updated";
    sub = "Your new password is active. Every device was signed out, so sign in again with it.";
  }

  return (
    <AuthSplit labelledBy="au-reset-title" corner={corner}>
      <h1 id="au-reset-title" className="au-title">
        {title}
      </h1>
      <p className="au-sub">{sub}</p>

      {!link ? (
        <div className="au-actions">
          <Link to="/login" className="au-btn au-btn--primary">
            Go to sign in
          </Link>
        </div>
      ) : done ? (
        <div className="au-submit-wrap">
          <Link to="/login" className="au-submit">
            <span>Sign in</span>
          </Link>
        </div>
      ) : (
        <form className="au-form" onSubmit={submit} noValidate>
          <div className="au-grid au-grid--2">
            <AuthField
              label="New password"
              name="password"
              reveal
              autoComplete="new-password"
              placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
              value={form.password}
              onChange={change}
              error={fieldError?.field === "password" ? fieldError.message : ""}
              required
              autoFocus
            />
            <AuthField
              label="Confirm password"
              name="confirm"
              reveal
              autoComplete="new-password"
              placeholder="Type it again"
              value={form.confirm}
              onChange={change}
              error={fieldError?.field === "confirm" ? fieldError.message : ""}
              required
            />
          </div>
          {error ? (
            <AuthMessage tone="error">
              {error}{" "}
              <Link to="/login" className="au-link--strong" style={{ color: "inherit" }}>
                Ask for a new link
              </Link>
            </AuthMessage>
          ) : null}
          <div className="au-submit-wrap">
            <AuthSubmit loading={busy}>Set new password</AuthSubmit>
          </div>
        </form>
      )}
    </AuthSplit>
  );
}

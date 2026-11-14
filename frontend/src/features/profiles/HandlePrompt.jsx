// One-time "customise your handle" prompt (owner privacy rule: inside the app
// every student is shown by their profile HANDLE only). Students whose handle
// was assigned automatically (operative_xxxxxx) are asked once to pick their
// own; "Keep it" dismisses the prompt for good. Renders nothing for staff,
// instructors, signed-out visitors, when profiles are switched off, or once
// the prompt was answered. OWNER: WS-PROFILES.
import { useEffect, useId, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { Button } from "../../kit/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../kit/Dialog";
import { Field, Input } from "../../kit/Form";
import { holdDialog, releaseDialog, useDialogTurn } from "../app-shell/dialogQueue";
import { changeHandle, dismissHandlePrompt, fetchMyProfile } from "./profilesApi";

const SEEN_KEY = "handle-prompt-answered";

/** Should the prompt open for this profile payload (GET /api/profiles/me/)? */
export function shouldPromptForHandle(profile) {
  return Boolean(profile && profile.handle_prompt && profile.handle_auto);
}

/** Client-side mirror of the server's handle rule (the server stays the judge). */
export function handleProblem(value) {
  const handle = String(value || "").trim().replace(/^@/, "").toLowerCase();
  if (!handle) return "Type a handle.";
  if (!/^[a-z0-9](?:[a-z0-9_]{1,28})[a-z0-9]$/.test(handle) || handle.includes("__")) {
    return "Use 3-30 lower-case letters, numbers or single underscores.";
  }
  if (handle.startsWith("operative_")) return "Handles starting with operative_ are kept for automatic handles.";
  return "";
}

function errorText(error, fallback) {
  const body = error?.response?.data;
  const fieldError = body?.errors?.handle;
  if (Array.isArray(fieldError) && fieldError.length) return String(fieldError[0]);
  return body?.message || fallback;
}

function readSeen(userId) {
  try {
    return window.sessionStorage.getItem(`${SEEN_KEY}:${userId}`) === "1";
  } catch {
    return false;
  }
}

function writeSeen(userId) {
  try {
    window.sessionStorage.setItem(`${SEEN_KEY}:${userId}`, "1");
  } catch {
    // per-tab convenience only; the server remembers the answer
  }
}

export default function HandlePrompt() {
  const { user } = useAuth();
  const inputId = useId();
  const [profile, setProfile] = useState(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One shell dialog at a time: the journey welcome goes first.
  const myTurn = useDialogTurn("handle");

  const isStudent = Boolean(user?.id) && !user?.is_admin && user?.role !== "instructor";

  useEffect(() => {
    if (!isStudent || readSeen(user.id)) return undefined;
    let active = true;
    fetchMyProfile()
      .then((data) => {
        if (!active || !shouldPromptForHandle(data)) return;
        holdDialog("handle");
        setProfile(data);
        setOpen(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isStudent, user?.id]);

  useEffect(() => () => releaseDialog("handle"), []);

  if (!profile) return null;

  const close = () => {
    writeSeen(user.id);
    setOpen(false);
    releaseDialog("handle");
  };

  const keep = async () => {
    setBusy(true);
    try {
      await dismissHandlePrompt();
      close();
    } catch (err) {
      setError(errorText(err, "Could not save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const save = async (event) => {
    event.preventDefault();
    const problem = handleProblem(value);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await changeHandle(value.trim().replace(/^@/, "").toLowerCase());
      close();
    } catch (err) {
      setError(errorText(err, "Could not change your handle. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open && myTurn} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogContent data-testid="handle-prompt">
        <form onSubmit={save} noValidate>
          <DialogHeader>
            <DialogTitle>Choose your handle</DialogTitle>
            <DialogDescription>
              Other students see you only by your handle, never by your name. Yours is{" "}
              <strong>@{profile.handle}</strong> for now. Pick your own, or keep it.
            </DialogDescription>
          </DialogHeader>
          <Field label="New handle" hint="3-30 lower-case letters, numbers or underscores. Don't use your real name." error={error} id={inputId} className="mt-4">
            <Input
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder="quiet_cipher"
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError("");
              }}
            />
          </Field>
          <DialogFooter className="mt-6 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={keep} disabled={busy}>
              Keep @{profile.handle}
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Save handle
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// "Report profile": reason + optional details -> POST /report/ (moderation
// queue). One open report per member per profile (409 already_reported).
// OWNER: WS-PROFILES.
import { useId, useState } from "react";

import { Button } from "../../kit/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../kit/Dialog";
import { Label, Textarea } from "../../kit/Form";
import { REPORT_REASONS } from "./profileModel";
import { readError, reportProfile } from "./profilesApi";

export default function ReportProfileDialog({ handle }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [state, setState] = useState({ status: "idle", message: "" });
  const groupId = useId();

  async function submit(event) {
    event.preventDefault();
    if (state.status === "sending") return;
    if (!reason) {
      setState({ status: "error", message: "Choose a reason." });
      return;
    }
    setState({ status: "sending", message: "" });
    try {
      await reportProfile(handle, reason, details.trim());
      setState({ status: "sent", message: "Thanks. A moderator will review this profile." });
    } catch (error) {
      const info = readError(error);
      setState({ status: info.code === "already_reported" ? "sent" : "error", message: info.message });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setState({ status: "idle", message: "" });
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="xs" className="text-muted-foreground">
          Report profile
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report @{handle}</DialogTitle>
          <DialogDescription>A moderator reviews every report. The owner is not told who reported them.</DialogDescription>
        </DialogHeader>
        {state.status === "sent" ? (
          <div className="mt-6 space-y-6">
            <p role="status" className="text-sm leading-6 text-[#d4d4d4]">
              {state.message}
            </p>
            <DialogFooter>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="mt-6 space-y-6" onSubmit={submit} noValidate>
            <fieldset aria-describedby={state.status === "error" ? `${groupId}-error` : undefined}>
              <legend className="text-sm font-medium text-white/[.82]">What is wrong?</legend>
              <div className="mt-3 grid gap-2">
                {REPORT_REASONS.map((option) => (
                  <label
                    key={option.value}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-white/10 px-4 text-sm text-[#d4d4d4] transition-colors duration-150 hover:border-white/25 has-[:checked]:border-white has-[:checked]:text-white has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring motion-reduce:transition-none"
                  >
                    <input
                      type="radio"
                      name={`${groupId}-reason`}
                      value={option.value}
                      checked={reason === option.value}
                      onChange={() => setReason(option.value)}
                      className="size-4 accent-white"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor={`${groupId}-details`}>Details (optional)</Label>
              <Textarea
                id={`${groupId}-details`}
                maxLength={500}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
                placeholder="What should the moderator look at?"
              />
            </div>
            {state.status === "error" ? (
              <p id={`${groupId}-error`} role="alert" className="text-sm text-white">
                {state.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" aria-disabled={state.status === "sending" || undefined}>
                {state.status === "sending" ? "Sending…" : "Send report"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

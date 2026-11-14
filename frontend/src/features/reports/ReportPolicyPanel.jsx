import { Save } from "@carbon/icons-react";
import { Button, InlineLoading, InlineNotification, Select, SelectItem, TextInput, Toggle } from "@carbon/react";
import { useEffect, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import { getCoursePolicy, updateCoursePolicy } from "./reportsApi";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "Sunday 23:59 IST · 48 h late window at -10%/day · no target limit" */
export function describePolicy(policy) {
  if (!policy) return "";
  const time = String(policy.due_time || "23:59").slice(0, 5);
  const penalty = Number(policy.late_penalty_percent_per_day) || 0;
  const parts = [`Due ${WEEKDAYS[policy.due_weekday ?? 6]} ${time} IST`];
  parts.push(policy.grace_hours ? `${policy.grace_hours} h late window${penalty ? ` at -${penalty}%/day` : ""}` : "no late reports");
  parts.push(policy.max_targets_per_week ? `up to ${policy.max_targets_per_week} targets a week` : "no target limit");
  return parts.join(" · ");
}

/** Validates the "max targets" field: "" (no limit) or 1-50. */
export function parseMaxTargets(value) {
  const text = String(value ?? "").trim();
  if (!text) return { value: null, error: "" };
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1 || number > 50) return { value: null, error: "Use a whole number from 1 to 50, or leave it empty." };
  return { value: number, error: "" };
}

/** Per-course weekly report policy: self-service on/off and the main rules. */
export default function ReportPolicyPanel({ courseId, notify }) {
  const [state, setState] = useState({ policy: null, loading: true, error: "" });
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (!courseId) return;
    let alive = true;
    setState({ policy: null, loading: true, error: "" });
    getCoursePolicy(courseId)
      .then((response) => {
        if (!alive) return;
        const policy = apiData(response, null);
        setState({ policy, loading: false, error: "" });
        setDraft({ ...policy, max_targets_per_week: policy?.max_targets_per_week ?? "" });
      })
      .catch((error) => alive && setState({ policy: null, loading: false, error: apiMessage(error, "Please try again.") }));
    return () => {
      alive = false;
    };
  }, [courseId]);

  if (state.loading) return <InlineLoading description="Loading report settings…" />;
  if (state.error || !draft) return <InlineNotification kind="error" lowContrast hideCloseButton title="Couldn't load report settings." subtitle={state.error} />;

  const maxTargets = parseMaxTargets(draft.max_targets_per_week);
  const save = () => {
    setSaving(true);
    setSaveError("");
    updateCoursePolicy(courseId, { ...draft, max_targets_per_week: maxTargets.value })
      .then((response) => {
        const policy = apiData(response, null);
        setState({ policy, loading: false, error: "" });
        setDraft({ ...policy, max_targets_per_week: policy?.max_targets_per_week ?? "" });
        notify?.({ kind: "success", title: response?.data?.message || "Report settings saved." });
      })
      .catch((error) => setSaveError(apiMessage(error, "Not saved. Try again.")))
      .finally(() => setSaving(false));
  };

  return (
    <section className="rpt-section rpt-policy" aria-labelledby="rpt-policy-title">
      <h2 id="rpt-policy-title" className="cds-section-title">
        Weekly reports
      </h2>
      <p className="rpt-muted">{describePolicy(state.policy)}</p>
      <Toggle
        id={`rpt-policy-self-service-${courseId}`}
        labelText="Self-service weekly reports"
        labelA="Off: you set each week's target"
        labelB="On: students name their targets, weeks are automatic"
        toggled={Boolean(draft.self_service)}
        onToggle={(value) => setDraft((current) => ({ ...current, self_service: value }))}
      />
      <div className="rpt-policy__fields">
        <TextInput
          id={`rpt-policy-max-${courseId}`}
          labelText="Targets per student per week"
          helperText="Leave empty for no limit."
          inputMode="numeric"
          value={String(draft.max_targets_per_week ?? "")}
          invalid={Boolean(maxTargets.error)}
          invalidText={maxTargets.error}
          onChange={(event) => setDraft((current) => ({ ...current, max_targets_per_week: event.target.value }))}
        />
        <Select
          id={`rpt-policy-visibility-${courseId}`}
          labelText="When students see marks"
          value={draft.marks_visibility}
          onChange={(event) => setDraft((current) => ({ ...current, marks_visibility: event.target.value }))}
        >
          <SelectItem value="on_grade" text="As soon as each report is graded" />
          <SelectItem value="auto_release" text="Automatically after the late window" />
          <SelectItem value="on_release" text="When I release them" />
        </Select>
      </div>
      {saveError ? <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved." subtitle={saveError} /> : null}
      <Button kind="secondary" size="md" renderIcon={Save} disabled={saving || Boolean(maxTargets.error)} onClick={save}>
        {saving ? "Saving…" : "Save report settings"}
      </Button>
    </section>
  );
}

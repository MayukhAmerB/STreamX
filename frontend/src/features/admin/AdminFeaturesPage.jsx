// /console/admin/settings/features: platform switches (plan §5.5). OWNER: WS-G.
// Same service as the back-office Features page (WS-F): GET
// /api/admin/features/ and POST /api/admin/features/<key>/ with
// {enabled, expected_version, note, reason} → set_feature(). Flipping a
// switch never happens on one click: it opens an inline confirm panel that
// says who notices; success offers Undo; a version conflict asks to review.
import {
  CheckmarkFilled,
  ChevronDown,
  Locked,
  SettingsAdjust,
} from "@carbon/icons-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  StatusTag,
  useSkeletonGate,
  useToast,
} from "../app-shell/ui";
import { SkeletonBlocks } from "./AdminBits";
import { fetchFeatures, setFeature } from "./api";
import { dateTime, plural } from "./format";
import useAdminData from "./useAdminData";
import "./admin.scss";

export const REASON_MAX = 160;

/**
 * Plain-language consequences per switch (shown on the card and in the confirm
 * panel). Any switch registered on the server renders without an entry here:
 * the card then shows its summary and the generic lines below.
 *   who     [label, text] pairs: who notices
 *   on/off  bullets for the confirm panel
 *   saved   {on, off}: the sentence after a change
 *   reader  who reads the "switched off" reason
 */
export const FEATURE_COPY = {
  teaching: {
    who: [
      [
        "When off",
        "instructors see the section greyed out with a short reason",
      ],
      ["Students", "never affected"],
      ["Admins", "your own tools stay on"],
    ],
    on: [
      "Instructor accounts get their Teach workspace: Today, Courses, Classes, Recordings, Grading and Exams.",
      "It appears for them within seconds; nothing changes for students.",
    ],
    off: [
      "Instructors keep Learn; Teach turns grey with the reason below.",
      "A class already on air keeps going until it ends. New sessions are refused.",
      "Unsaved course edits stay on the instructor's device.",
    ],
    saved: {
      on: "Instructors will see it within seconds.",
      off: "Instructors see it greyed out within seconds.",
    },
    reader: "instructors",
    placeholder:
      "Teaching tools are switched off for now. An admin can turn them on.",
  },
  engagement: {
    who: [
      [
        "When off",
        "no XP, streaks, badges or leaderboards are shown or earned",
      ],
      ["Stored XP", "kept"],
      ["Teachers and admins", "not affected"],
    ],
    saved: {
      on: "Students see XP and streaks within seconds.",
      off: "XP, streaks and leaderboards are hidden within seconds.",
    },
    reader: "students",
  },
  pentesting: {
    who: [
      [
        "When off",
        "visitors can browse every Pentesting course; enrol, buy and subscribe show “Coming soon”",
      ],
      ["Paid students", "keep their access"],
      ["Orders already paid", "still complete"],
    ],
    on: [
      "Pentesting courses that are live and have a confirmed, enabled plan become purchasable.",
      "Courses still marked coming soon, or with no confirmed price, stay closed.",
    ],
    off: [
      "Every enrol, buy, subscribe and start button for Pentesting shows the reason below.",
      "Nobody loses access they already paid for.",
    ],
    saved: {
      on: "Pentesting can be bought within seconds.",
      off: "Pentesting shows “Coming soon” within seconds.",
    },
    reader: "visitors",
    placeholder:
      "Pentesting is coming soon. You can browse every course now; enrolment opens at launch.",
  },
  memberships: {
    who: [
      ["When off", "monthly and yearly plans show “Coming soon”"],
      ["Members", "keep access until their paid period ends"],
    ],
    on: [
      "Plans with a confirmed price and a Razorpay plan id can be subscribed to.",
      "Plans without a confirmed price stay closed.",
    ],
    off: [
      "New subscriptions are refused with the reason below.",
      "Existing members keep access until their paid period ends.",
    ],
    saved: {
      on: "Memberships open within seconds.",
      off: "Memberships show “Coming soon” within seconds.",
    },
    reader: "visitors",
  },
  labs_membership_required: {
    who: [
      ["When on", "the labs ask for sign-in and an active labs membership"],
      ["Staff", "always allowed"],
      ["When off", "the labs stay as open as they are today"],
    ],
    on: [
      "Learners without an active labs membership can no longer open the labs.",
      "Check that the membership plan is confirmed and on before turning this on.",
    ],
    off: ["The labs open to everyone again, exactly as before."],
    saved: {
      on: "The labs now ask for a membership.",
      off: "The labs are open again.",
    },
    reader: "learners",
  },
};

/** Readable names for the impact numbers a switch reports (any other key is humanised). */
const IMPACT_WORDS = {
  instructor_accounts: ["instructor account", "instructor accounts"],
  live_now: ["class on air now", "classes on air now"],
  pentesting_courses: ["Pentesting course", "Pentesting courses"],
  ready_to_sell: ["ready to sell", "ready to sell"],
  waiting_for_price: ["waiting for a price", "waiting for a price"],
  plans_confirmed: ["plan confirmed", "plans confirmed"],
  active_subscriptions: ["active subscription", "active subscriptions"],
  plans_waiting_for_price: [
    "plan waiting for a price",
    "plans waiting for a price",
  ],
  members_with_access: ["member with access", "members with access"],
};

const GENERIC_SAVED = {
  on: "Everyone affected sees it within seconds.",
  off: "Everyone affected sees it switched off within seconds.",
};

/** The sentence after a change: per-switch copy, then the generic one. */
export function savedSentence(feature, target) {
  const saved = FEATURE_COPY[feature?.key]?.saved || GENERIC_SAVED;
  return `${feature?.label || "The switch"} is ${target ? "on" : "off"}. ${target ? saved.on : saved.off}`;
}

export function impactLine(impact = {}) {
  const parts = [];
  for (const [key, raw] of Object.entries(impact || {})) {
    if (raw == null || typeof raw === "boolean" || typeof raw === "object")
      continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    // A class on air only matters when there is one.
    if (key === "live_now" && value <= 0) continue;
    const [one, many] = IMPACT_WORDS[key] || [
      key.replace(/_/g, " "),
      key.replace(/_/g, " "),
    ];
    parts.push(`${value} ${value === 1 ? one : many}`);
  }
  return parts.join(" · ");
}
function changedLine(feature) {
  if (feature.updated_at) {
    const who = feature.updated_by ? ` by ${feature.updated_by}` : "";
    return `Turned ${feature.enabled ? "on" : "off"}${who} · ${dateTime(feature.updated_at)}`;
  }
  return feature.enabled === feature.default
    ? "Default setting"
    : "Set by server configuration";
}

export function FeatureSwitch({
  checked,
  disabled,
  onClick,
  labelledBy,
  describedBy,
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      className={`adm-switch${checked ? " is-on" : ""}${disabled ? " is-disabled" : ""}`}
      onClick={() => {
        if (!disabled) onClick?.();
      }}
    >
      <span className="adm-switch__state" aria-hidden="true">
        {checked ? "On" : "Off"}
      </span>
      <span className="adm-switch__track" aria-hidden="true">
        <span className="adm-switch__knob" />
      </span>
    </button>
  );
}

function ConfirmPanel({ feature, target, busy, error, onCancel, onConfirm }) {
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const titleRef = useRef(null);
  const ids = useId();
  const copy = FEATURE_COPY[feature.key] || {};
  const bullets = target ? copy.on : copy.off;
  const live = Number(feature.impact?.live_now) || 0;
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  const verb = target ? "Turn on" : "Turn off";
  return (
    <div
      className="adm-confirm"
      role="group"
      aria-labelledby={`${ids}-title`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <h3
        id={`${ids}-title`}
        ref={titleRef}
        tabIndex={-1}
        className="adm-confirm__title"
      >
        {verb} the {feature.label}?
      </h3>
      {impactLine(feature.impact) ? (
        <p className="adm-confirm__lead">
          {impactLine(feature.impact)} will notice within a minute.
        </p>
      ) : null}
      {bullets?.length ? (
        <ul className="adm-confirm__list">
          {bullets.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {!target && live ? (
        <p className="adm-panel__note">
          {plural(live, "class", "classes")} {live === 1 ? "is" : "are"} on air
          now and will not be cut.
        </p>
      ) : null}
      <label className="adm-field" htmlFor={`${ids}-note`}>
        <span className="adm-field__label">
          Note for the history (optional)
        </span>
        <textarea
          id={`${ids}-note`}
          rows={2}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {!target ? (
        <label className="adm-field" htmlFor={`${ids}-reason`}>
          <span className="adm-field__label">
            What {copy.reader || "people"} will read (optional)
          </span>
          <textarea
            id={`${ids}-reason`}
            rows={2}
            maxLength={REASON_MAX}
            value={reason}
            placeholder={copy.placeholder || feature.disabled_reason || ""}
            onChange={(event) => setReason(event.target.value)}
          />
          <span className="adm-field__help">
            {reason.length}/{REASON_MAX}
          </span>
        </label>
      ) : null}
      {error ? (
        <p className="adm-panel__note adm-panel__note--error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="adm-confirm__actions">
        <button
          type="button"
          className="adm-button adm-button--secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`adm-button ${target ? "adm-button--accent" : "adm-button--primary"}`}
          onClick={() =>
            onConfirm({ note: note.trim(), reason: reason.trim() || null })
          }
          disabled={busy}
        >
          {busy ? "Saving…" : verb}
        </button>
      </div>
    </div>
  );
}

function HistoryToggle({ count, open, controls, onToggle }) {
  if (!count)
    return <span className="adm-feature__history-empty">No changes yet</span>;
  return (
    <button
      type="button"
      className="adm-link adm-link--button adm-history__toggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      History ({count})
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="adm-history__chevron"
      />
    </button>
  );
}

function HistoryList({ id, items = [] }) {
  return (
    <ol id={id} className="adm-history__list">
      {items.map((entry, index) => (
        <li key={`${entry.changed_at}-${index}`}>
          <span className="adm-history__what">
            Turned {entry.to ? "on" : "off"}
            {entry.changed_by ? ` by ${entry.changed_by}` : ""}
          </span>
          <span className="adm-history__when">
            {dateTime(entry.changed_at)}
          </span>
          {entry.note ? (
            <span className="adm-history__note">“{entry.note}”</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function FeatureCard({ feature, onChanged }) {
  const ids = useId();
  const { showToast } = useToast();
  const [confirm, setConfirm] = useState(null); // target state while confirming
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const switchRef = useRef(null);
  const copy = FEATURE_COPY[feature.key] || {};

  const submit = useCallback(
    async (
      target,
      {
        note = "",
        reason = null,
        version = feature.version,
        undo = false,
      } = {},
    ) => {
      setBusy(true);
      setError("");
      try {
        const response = await setFeature(feature.key, {
          enabled: target,
          expected_version: version,
          note,
          reason,
        });
        const card = apiData(response, null);
        setConfirm(null);
        onChanged?.(card || { ...feature, enabled: target });
        setSaved(savedSentence(feature, target));
        showToast({
          kind: "success",
          title: `${feature.label} is ${target ? "on" : "off"}`,
          subtitle: undo ? "Undone." : "Saved and recorded in the history.",
          action:
            undo || !card
              ? null
              : {
                  label: "Undo",
                  onClick: () =>
                    submit(!target, {
                      note: "Undo",
                      version: card.version,
                      undo: true,
                    }),
                },
        });
        window.requestAnimationFrame(() =>
          switchRef.current?.querySelector("button")?.focus(),
        );
      } catch (failure) {
        const code =
          failure?.response?.data?.code ||
          failure?.response?.data?.errors?.code;
        if (
          failure?.response?.status === 409 ||
          code === "feature_changed_meanwhile"
        ) {
          setError(
            "Someone changed this switch meanwhile. Review it and try again.",
          );
          onChanged?.(null);
        } else {
          setError(
            apiMessage(failure, "The switch was not changed. Try again."),
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [feature, onChanged, showToast],
  );

  const impact = impactLine(feature.impact);
  return (
    <article
      className={`adm-feature${feature.enabled ? " is-on" : ""}${confirm !== null ? " is-confirming" : ""}`}
      aria-labelledby={`${ids}-label`}
      data-feature={feature.key}
    >
      <div className="adm-feature__body">
        <div className="adm-feature__head">
          <div className="adm-feature__title">
            <StatusTag status={feature.enabled ? "on" : "off"} />
            <h2 id={`${ids}-label`} className="adm-feature__label">
              {feature.label}
            </h2>
          </div>
          <div ref={switchRef} className="adm-feature__switch">
            <FeatureSwitch
              checked={Boolean(feature.enabled)}
              disabled={feature.locked || busy}
              labelledBy={`${ids}-label`}
              describedBy={feature.locked ? `${ids}-locked` : `${ids}-summary`}
              onClick={() => {
                setSaved("");
                setError("");
                setConfirm(!feature.enabled);
              }}
            />
          </div>
        </div>
        <p id={`${ids}-summary`} className="adm-feature__summary">
          {feature.summary}
        </p>
        {copy.who ? (
          <p className="adm-feature__who">
            {copy.who.map(([label, text]) => (
              <span key={label}>
                <span className="adm-feature__who-label">{label}:</span> {text}
              </span>
            ))}
          </p>
        ) : null}
        {feature.locked ? (
          <p id={`${ids}-locked`} className="adm-feature__locked">
            <Locked size={16} aria-hidden="true" /> Locked by server
            configuration. Change FEATURE_FORCE on the server to unlock it.
          </p>
        ) : null}
        {confirm !== null ? (
          <ConfirmPanel
            feature={feature}
            target={confirm}
            busy={busy}
            error={error}
            onCancel={() => {
              setConfirm(null);
              setError("");
              switchRef.current?.querySelector("button")?.focus();
            }}
            onConfirm={(fields) => submit(confirm, fields)}
          />
        ) : null}
        {confirm === null && error ? (
          <p className="adm-panel__note adm-panel__note--error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="adm-feature__saved" role="status" aria-live="polite">
          {saved ? (
            <>
              <CheckmarkFilled
                size={16}
                aria-hidden="true"
                className="adm-feature__saved-icon"
              />{" "}
              {saved}
            </>
          ) : null}
        </p>
      </div>
      <footer className="adm-feature__foot">
        <span>{changedLine(feature)}</span>
        <span className="adm-feature__foot-end">
          {impact ? <span>{impact}</span> : null}
          <HistoryToggle
            count={feature.history?.length || 0}
            open={historyOpen}
            controls={`${ids}-history`}
            onToggle={() => setHistoryOpen((value) => !value)}
          />
        </span>
      </footer>
      {historyOpen && feature.history?.length ? (
        <HistoryList id={`${ids}-history`} items={feature.history} />
      ) : null}
    </article>
  );
}

export default function AdminFeaturesPage() {
  const list = useAdminData(fetchFeatures);
  const phase = useSkeletonGate(list.loading && !list.data);
  const features = Array.isArray(list.data) ? list.data : [];

  const onChanged = useCallback(
    (card) => {
      if (!card) {
        list.reload({ quiet: true });
        return;
      }
      list.setData((current) =>
        Array.isArray(current)
          ? current.map((item) => (item.key === card.key ? card : item))
          : current,
      );
    },
    [list],
  );

  let body;
  if (list.error && !list.data)
    body = <ErrorState error={list.error} onRetry={() => list.reload()} />;
  else if (!list.data)
    body =
      phase === "skeleton" ? (
        <SkeletonBlocks
          count={1}
          className="adm-skeleton-card"
          label="Loading switches"
        />
      ) : (
        <div className="adm-skeleton adm-skeleton--waiting" />
      );
  else if (!features.length)
    body = (
      <EmptyState
        icon={SettingsAdjust}
        title="No switches yet."
        action={
          <a className="adm-link" href="/admin/settings/features/">
            Open the back office
          </a>
        }
      />
    );
  else
    body = (
      <div className="adm-features">
        {features.map((feature) => (
          <FeatureCard
            key={feature.key}
            feature={feature}
            onChanged={onChanged}
          />
        ))}
      </div>
    );

  return (
    <div className="adm-page adm-page--narrow">
      <PageHeader
        title="Features"
        description="Turn whole sections of the Console on or off. Changes reach everyone within seconds, are recorded with your name and can be undone."
        eyebrow={null}
        breadcrumbs={[{ label: "Settings" }, { label: "Features" }]}
      />
      {body}
      <p className="adm-quiet adm-features__more">
        The same switches are in the back office under{" "}
        <a className="adm-link" href="/admin/settings/features/">
          Settings › Features
        </a>
        .
      </p>
    </div>
  );
}

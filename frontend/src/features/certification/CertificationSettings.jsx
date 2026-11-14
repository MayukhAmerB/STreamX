// Profile > "Certificates": how the student receives a certificate and whether
// their handle is listed in the Hall of Fame (GET/PATCH /api/certification/me/preferences/).
import { RadioButton, RadioButtonGroup, Tile } from "@carbon/react";
import { useEffect, useState } from "react";

import { apiMessage } from "../../utils/api";
import { fetchCertificationPreferences, saveCertificationPreferences } from "./certificationApi";

const CHANNELS = [
  { value: "both", label: "E-mail and WhatsApp" },
  { value: "email", label: "E-mail only" },
  { value: "whatsapp", label: "WhatsApp only" },
];

function Switch({ id, label, help, on, disabled, onChange }) {
  return (
    <div className="cds-profile-motion__row">
      <span className="cds-profile-motion__text">
        <span className="cds-profile-motion__label" id={`${id}-label`}>
          {label}
        </span>
        <span className="cds-profile-motion__help" id={`${id}-help`}>
          {help}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        id={id}
        className="cds-profile-switch"
        aria-checked={Boolean(on)}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        disabled={disabled}
        onClick={() => onChange?.(!on)}
      >
        <span className="cds-profile-switch__track" aria-hidden="true">
          <span className="cds-profile-switch__knob" />
        </span>
        <span className="cds-profile-switch__state" aria-hidden="true">
          {on ? "On" : "Off"}
        </span>
      </button>
    </div>
  );
}

/** Presentational settings tile (tests render it directly). */
export function CertificationSettingsView({ prefs, saving = false, error = "", onChange }) {
  if (!prefs) return null;
  const whatsappNote = !prefs.has_phone
    ? "Add a phone number above to receive certificates on WhatsApp."
    : prefs.whatsapp_opt_out
      ? "WhatsApp is off: certificates are sent by e-mail."
      : "";
  return (
    <Tile className="cds-profile-form-tile cds-profile-motion" data-section="certification-settings">
      <h2 className="cds-profile-motion__title">Certificates</h2>
      <RadioButtonGroup
        legendText="When you pass a certification exam, send my certificate and letter by"
        name="certification-channel"
        orientation="vertical"
        valueSelected={prefs.delivery_channel}
        onChange={(value) => onChange?.({ delivery_channel: value })}
        disabled={saving}
      >
        {CHANNELS.map((channel) => (
          <RadioButton key={channel.value} id={`certification-channel-${channel.value}`} labelText={channel.label} value={channel.value} />
        ))}
      </RadioButtonGroup>
      {whatsappNote ? <p className="cds-profile-motion__help">{whatsappNote}</p> : null}
      <Switch
        id="certification-whatsapp-opt-out"
        label="No WhatsApp messages"
        help="We never message you on WhatsApp while this is on."
        on={prefs.whatsapp_opt_out}
        disabled={saving}
        onChange={(value) => onChange?.({ whatsapp_opt_out: value })}
      />
      <Switch
        id="certification-hall-of-fame"
        label="List me in the Hall of Fame"
        help="Shows your handle (never your real name) with your batch and a link to your certificate."
        on={prefs.hall_of_fame_listed}
        disabled={saving}
        onChange={(value) => onChange?.({ hall_of_fame_listed: value })}
      />
      {error ? (
        <p className="cds-profile-motion__help" role="alert">
          {error}
        </p>
      ) : null}
    </Tile>
  );
}

export default function CertificationSettings() {
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchCertificationPreferences()
      .then((data) => alive && setPrefs(data))
      .catch(() => alive && setPrefs(null));
    return () => {
      alive = false;
    };
  }, []);

  const onChange = async (changes) => {
    const previous = prefs;
    setPrefs({ ...prefs, ...changes });
    setSaving(true);
    setError("");
    try {
      setPrefs(await saveCertificationPreferences(changes));
    } catch (err) {
      setPrefs(previous);
      setError(`Not saved. ${apiMessage(err, "Try again.")}`);
    } finally {
      setSaving(false);
    }
  };

  return <CertificationSettingsView prefs={prefs} saving={saving} error={error} onChange={onChange} />;
}

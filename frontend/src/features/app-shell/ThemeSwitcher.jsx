import { ContentSwitcher, Switch } from "@carbon/react";
import { useId } from "react";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
];

/** Light / Dark / Auto (follow the device) segmented control. */
export default function ThemeSwitcher({ value, onChange }) {
  const labelId = useId();
  const selectedIndex = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === value)
  );

  return (
    <div>
      <span id={labelId} className="cds-app-section-label">
        Appearance
      </span>
      <ContentSwitcher
        aria-labelledby={labelId}
        className="cds-app-theme-switch"
        selectedIndex={selectedIndex}
        size="lg"
        onChange={({ name }) => onChange(name)}
      >
        {OPTIONS.map((option) => (
          <Switch key={option.value} name={option.value} text={option.label} />
        ))}
      </ContentSwitcher>
    </div>
  );
}

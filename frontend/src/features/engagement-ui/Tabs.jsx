// Accessible tab bar (WAI-ARIA tabs, roving focus, arrow keys) in the
// HackPath T8 style: a row between two hairlines, the active tab solid white.
// OWNER: WS-LEARN. Small on purpose; the kit's Radix Tabs can replace it.
import { useRef } from "react";

export function TabBar({ tabs, value, onChange, label, idPrefix }) {
  const refs = useRef([]);
  const move = (index) => {
    const next = (index + tabs.length) % tabs.length;
    onChange(tabs[next].key);
    refs.current[next]?.focus();
  };
  return (
    <div className="eg-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => {
        const selected = tab.key === value;
        return (
          <button
            key={tab.key}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.key}`}
            tabIndex={selected ? 0 : -1}
            className={`eg-tabs__tab${selected ? " is-active" : ""}`}
            onClick={() => onChange(tab.key)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(index + 1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(index - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                move(0);
              } else if (event.key === "End") {
                event.preventDefault();
                move(tabs.length - 1);
              }
            }}
          >
            {tab.label}
            {tab.count != null ? <span className="eg-tabs__count">{tab.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, tabKey, active, children }) {
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${tabKey}`}
      aria-labelledby={`${idPrefix}-tab-${tabKey}`}
      hidden={!active}
      tabIndex={0}
      className="eg-tabpanel"
    >
      {active ? children : null}
    </div>
  );
}

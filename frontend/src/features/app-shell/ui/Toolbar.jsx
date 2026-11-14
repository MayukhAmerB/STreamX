// Toolbar (UI overhaul plan §2.5, §4.6, Appendix A.5). OWNER: WS-A.
// Search, filter chips (not filter rails), a count and saved views. `/`
// focuses the search from anywhere on the page (keyboard first). On phones
// the chips fold into one "Filters (n)" disclosure under the search.
import { Filter } from "@carbon/icons-react";
import { Search } from "@carbon/react";
import { useEffect, useId, useState } from "react";
import { useMediaQuery } from "../useBreakpoint";
import "./overhaul.scss";

const typingTarget = (target) => Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']")) || target?.isContentEditable;

export default function Toolbar({ search, chips = [], count, savedViews = null, onChipClick, label = "List tools", countLabel }) {
  const searchId = useId();
  const chipsId = useId();
  const narrow = useMediaQuery("(max-width: 41.98rem)");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeCount = chips.filter((chip) => chip.active).length;

  useEffect(() => {
    if (!search || typeof document === "undefined") return undefined;
    const onKey = (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || typingTarget(event.target)) return;
      const input = document.getElementById(searchId);
      if (!input) return;
      event.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [search, searchId]);

  const chipList = chips.length ? (
    <div className="sc-toolbar__chips" id={chipsId} role="group" aria-label="Filters" hidden={narrow && !filtersOpen ? true : undefined}>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="sc-chip"
          aria-pressed={Boolean(chip.active)}
          onClick={() => (chip.onClick ? chip.onClick(chip) : onChipClick?.(chip))}
        >
          {chip.label}
          {chip.count != null ? <span className="sc-chip__count">{chip.count}</span> : null}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="sc-toolbar" role="toolbar" aria-label={label}>
      {search ? (
        <div className="sc-toolbar__search">
          <Search
            id={searchId}
            size="md"
            labelText={search.label || search.placeholder || "Search"}
            placeholder={search.placeholder || "Search"}
            value={search.value}
            onChange={(event) => search.onChange?.(event.target.value)}
            closeButtonLabelText="Clear search"
          />
          <kbd className="sc-toolbar__hint" aria-hidden="true">
            /
          </kbd>
        </div>
      ) : null}
      {chips.length && narrow ? (
        <button
          type="button"
          className="sc-chip sc-toolbar__filters"
          aria-expanded={filtersOpen}
          aria-controls={chipsId}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <Filter size={16} aria-hidden="true" />
          Filters{activeCount ? ` (${activeCount})` : ""}
        </button>
      ) : null}
      {chipList}
      {savedViews ? <div className="sc-toolbar__views">{savedViews}</div> : null}
      {count != null ? (
        <p className="sc-toolbar__count" aria-live="polite">
          {countLabel || `${count} ${count === 1 ? "item" : "items"}`}
        </p>
      ) : null}
    </div>
  );
}

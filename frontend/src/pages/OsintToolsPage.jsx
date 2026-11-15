import "./OsintToolsPage.scss";

import { Launch, Search as SearchIcon } from "@carbon/icons-react";
import { Button, InlineNotification, Search, SelectableTag, Tag, Tile } from "@carbon/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, PageHeader } from "../features/app-shell/ui";
import {
  ALL_CLUES,
  allToolCount,
  CLUE_FILTERS,
  countTools,
  filterToolGroups,
  getCategory,
  getClueFilter,
  toSentenceCase,
} from "../features/osint-tools/osintLibrary";

const pluralTools = (count) => `${count} tool${count === 1 ? "" : "s"}`;

export function ToolCard({ tool }) {
  return (
    <Tile className="cds-osint-tool">
      <div className="cds-osint-tool__head">
        <h3 className="cds-osint-tool__name">{tool.name}</h3>
        <Tag type="gray" size="sm" className="cds-osint-tool__type">
          {tool.type}
        </Tag>
      </div>
      <p className="cds-osint-tool__use">{tool.use}</p>
      <div className="cds-osint-tool__actions">
        {tool.url ? (
          <Button
            as="a"
            href={tool.url}
            target="_blank"
            rel="noreferrer"
            kind="tertiary"
            size="md"
            renderIcon={Launch}
            aria-label={`Open ${tool.name} (opens in a new tab)`}
          >
            Open
          </Button>
        ) : (
          <span className="cds-osint-tool__reference">Reference only. No direct link.</span>
        )}
      </div>
    </Tile>
  );
}

function ToolGrid({ tools }) {
  return (
    <div className="cds-tile-grid cds-osint-grid">
      {tools.map((tool) => (
        <ToolCard key={tool.name} tool={tool} />
      ))}
    </div>
  );
}

/** Guidance for the selected clue: first step, what the tools answer, and cautions. */
function ClueGuide({ clue }) {
  const category = getCategory(clue.categoryTitle);
  if (!category) return null;
  return (
    <section className="cds-osint-guide" aria-labelledby="cds-osint-guide-title">
      <div className="cds-osint-guide__head">
        <h2 id="cds-osint-guide-title" className="cds-osint-guide__title">
          {toSentenceCase(category.title)}
        </h2>
        <Tag type="blue" size="sm">
          {pluralTools(category.tools.length)}
        </Tag>
      </div>
      <p className="cds-osint-guide__focus">{category.focus}</p>
      {clue.start ? (
        <p className="cds-osint-guide__start">
          <strong>Start here:</strong> {clue.start}
        </p>
      ) : null}
      <p className="cds-osint-guide__use-case">{category.useCase}</p>
      <InlineNotification
        className="cds-osint-guide__caution"
        kind="warning"
        lowContrast
        hideCloseButton
        title="Use with care."
        subtitle={category.caution}
      />
    </section>
  );
}

/** Presentational library view, also used by tests. */
export function OsintToolsView({ initialClueId = ALL_CLUES, initialQuery = "" }) {
  const [clueId, setClueId] = useState(initialClueId);
  const [query, setQuery] = useState(initialQuery);
  const clue = clueId === ALL_CLUES ? null : getClueFilter(clueId);
  const groups = useMemo(() => filterToolGroups({ clueId, query }), [clueId, query]);
  const resultCount = countTools(groups);
  const trimmedQuery = query.trim();
  const filtersActive = Boolean(clue || trimmedQuery);
  const chipsRef = useRef(null);

  // Phones show the chips as a swipeable row: keep the selected chip visible
  // (horizontal scroll of the row only, never the page).
  useEffect(() => {
    const row = chipsRef.current;
    const chip = row?.querySelector?.('[aria-pressed="true"]');
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    const left = chip.offsetLeft; // the row is the chips' offsetParent (position: relative)
    const right = left + chip.offsetWidth;
    if (left < row.scrollLeft || right > row.scrollLeft + row.clientWidth) {
      row.scrollTo?.({ left: Math.max(0, left - 16), behavior: "smooth" });
    }
  }, [clueId]);

  const clearFilters = () => {
    setQuery("");
    setClueId(ALL_CLUES);
  };

  return (
    <>
      <PageHeader
        title="OSINT tools"
        description="Pick the clue you have and open a tool that fits it."
      />

      <InlineNotification
        className="cds-page-notification"
        kind="info"
        lowContrast
        hideCloseButton
        title="For lawful, authorized research only."
        subtitle="Treat every result as a lead. Check it with a second source and note how you found it."
      />

      <div className="cds-osint-filters">
        <Search
          size="lg"
          labelText="Search tools"
          placeholder={`Search ${allToolCount} tools`}
          closeButtonLabelText="Clear search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
        />
        <p className="cds-osint-filters__label" id="cds-osint-clue-label">
          What clue do you have?
        </p>
        <div className="cds-osint-chips" role="group" aria-labelledby="cds-osint-clue-label" ref={chipsRef}>
          <SelectableTag
            size="lg"
            text="All tools"
            selected={!clue}
            onChange={() => setClueId(ALL_CLUES)}
          />
          {CLUE_FILTERS.map((item) => (
            <SelectableTag
              key={item.id}
              size="lg"
              text={item.label}
              selected={clueId === item.id}
              onChange={(selected) => setClueId(selected ? item.id : ALL_CLUES)}
            />
          ))}
        </div>
      </div>

      {clue && !trimmedQuery ? <ClueGuide clue={clue} /> : null}

      <div className="cds-osint-results-bar">
        <p className="cds-osint-results" role="status" aria-live="polite">
          {resultCount === 0
            ? "No tools found"
            : `${pluralTools(resultCount)}${trimmedQuery ? ` matching “${trimmedQuery}”` : ""}`}
        </p>
        {filtersActive ? (
          <Button kind="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {resultCount === 0 ? (
        <EmptyState
          icon={SearchIcon}
          text={trimmedQuery ? `No tools match “${trimmedQuery}”. Try another word.` : "No tools in this category yet."}
          action={
            <Button kind="tertiary" onClick={clearFilters}>
              Show all tools
            </Button>
          }
        />
      ) : clue ? (
        <ToolGrid tools={groups[0].tools} />
      ) : (
        groups.map((group) => (
          <section key={group.category.title} className="cds-osint-group" aria-label={group.title}>
            <div className="cds-osint-group__head">
              <h2 className="cds-osint-group__title">{group.title}</h2>
              <Tag type="gray" size="sm">
                {group.tools.length}
              </Tag>
            </div>
            <p className="cds-osint-group__focus">{group.category.focus}</p>
            <ToolGrid tools={group.tools} />
          </section>
        ))
      )}
    </>
  );
}

export default function OsintToolsPage() {
  return <OsintToolsView />;
}

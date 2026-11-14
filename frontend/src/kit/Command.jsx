// Command palette on Radix Dialog (no cmdk; deps.md). OWNER: WS-KIT.
//
// A combobox input + listbox (aria-activedescendant), grouped results, our
// own ranking, arrow keys / Home / End / Enter, Esc closes and focus returns
// to the opener (useReturnFocus, also without a trigger). Disabled commands stay listed with their reason
// ("disable, not hide") and cannot be run. Ctrl/Cmd+K opens it
// (useCommandShortcut). Black #111 panel, hairlines, the active row is a
// white/[.06] wash with a golden left rule (one accent, no hue).
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { useReturnFocus } from "./Dialog";
import { Search } from "./icons";
import { cn } from "./lib/cn";

/** Lower case without accents ("résumé" finds "resume"). */
const normalise = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");

/** Ranks one string against the query: 0 = no match, higher is better. */
export function scoreText(text, query) {
  const hay = normalise(text);
  const needle = normalise(query).trim();
  if (!needle) return 1;
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 80;
  if (hay.split(/[\s/\-_.]+/).some((word) => word.startsWith(needle))) return 60;
  if (hay.includes(needle)) return 40;
  // Subsequence ("adfe" finds "Admin features"), weaker.
  let at = 0;
  for (const char of needle.replace(/\s+/g, "")) {
    at = hay.indexOf(char, at);
    if (at < 0) return 0;
    at += 1;
  }
  return 10;
}

/**
 * Filters and orders commands for a query. Stable within equal scores (the
 * caller's order). Each item: { id, label, group?, hint?, keywords?, disabled?, reason?, onSelect? }.
 */
export function filterCommands(items = [], query = "") {
  return items
    .map((item, index) => {
      const score = Math.max(scoreText(item.label, query), ...(item.keywords || []).map((word) => Math.max(0, scoreText(word, query) - 5)));
      return { item, score, index };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

/** Groups in first-seen order: [{ name, items }]. */
function groupBy(items) {
  const groups = new Map();
  items.forEach((item) => {
    const name = item.group || "";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  });
  return [...groups.entries()].map(([name, list]) => ({ name, items: list }));
}

/** Ctrl+K / Cmd+K toggles the palette. */
export function useCommandShortcut(setOpen, { key = "k" } = {}) {
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && String(event.key).toLowerCase() === key) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen, key]);
}

/**
 * <CommandPalette open onOpenChange items placeholder emptyText title />
 * `onSelect(item)` runs after the dialog closes (also item.onSelect).
 */
export function CommandPalette({
  open,
  onOpenChange,
  items = [],
  onSelect,
  title = "Go to",
  placeholder = "Search pages and actions",
  emptyText = "Nothing matches that search.",
  className,
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionId = (index) => `${listId}-opt-${index}`;
  const listRef = useRef(null);
  const focus = useReturnFocus();

  const results = useMemo(() => filterCommands(items, query), [items, query]);
  const groups = useMemo(() => groupBy(results), [results]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    const node = listRef.current?.querySelector?.(`[data-index="${active}"]`);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const run = useCallback(
    (item) => {
      if (!item || item.disabled) return;
      onOpenChange?.(false);
      // After the close so focus restoration does not fight a navigation.
      setTimeout(() => {
        item.onSelect?.(item);
        onSelect?.(item);
      }, 0);
    },
    [onOpenChange, onSelect]
  );

  const onKeyDown = (event) => {
    const count = flat.length;
    if (!count) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index - 1 + count) % count);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && event.ctrlKey) {
      event.preventDefault();
      setActive(count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(flat[active]);
    }
  };

  let running = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm data-[state=open]:animate-fade-in motion-reduce:animate-none" />
        <DialogPrimitive.Content
          {...focus}
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-[12vh] z-[91] w-[calc(100vw-2.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-white/10 bg-card-raised text-white shadow-window",
            "data-[state=open]:animate-fade-in motion-reduce:animate-none focus-visible:outline-none",
            className
          )}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-white/10 px-4">
            <Search size={18} className="shrink-0 text-subtle" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              aria-label={title}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat.length ? optionId(active) : undefined}
              className="h-14 w-full bg-transparent text-base text-white placeholder:text-placeholder focus:outline-none"
            />
            <kbd className="hidden shrink-0 rounded border border-white/15 px-1.5 py-0.5 font-mono text-[10px] text-subtle sm:inline">Esc</kbd>
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label={title} className="max-h-[min(24rem,60vh)] overflow-y-auto p-2">
            {flat.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
            ) : (
              groups.map((group, groupIndex) => {
                const headingId = `${listId}-g-${groupIndex}`;
                return (
                  <div key={group.name || groupIndex} role="group" aria-labelledby={group.name ? headingId : undefined} className="py-1">
                    {group.name ? (
                      <p id={headingId} className="eyebrow px-3 pb-1 pt-2" role="presentation">
                        {group.name}
                      </p>
                    ) : null}
                    {group.items.map((item) => {
                      running += 1;
                      const index = running;
                      const selected = index === active;
                      return (
                        <div
                          key={item.id || item.label}
                          id={optionId(index)}
                          data-index={index}
                          role="option"
                          aria-selected={selected}
                          aria-disabled={item.disabled ? "true" : undefined}
                          onPointerMove={() => setActive(index)}
                          onClick={() => run(item)}
                          className={cn(
                            "relative flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm",
                            selected ? "bg-white/[.06] text-white" : "text-white/[.82]",
                            item.disabled && "cursor-not-allowed text-muted-foreground"
                          )}
                        >
                          {selected ? <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" /> : null}
                          {item.icon ? <item.icon size={16} className="shrink-0 text-subtle" /> : null}
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {item.disabled && item.reason ? (
                            <span className="shrink-0 text-xs text-subtle">{item.reason}</span>
                          ) : item.hint ? (
                            <span className="shrink-0 text-xs text-subtle">{item.hint}</span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
          <p className="sr-only" aria-live="polite">
            {query ? `${flat.length} result${flat.length === 1 ? "" : "s"}` : ""}
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default CommandPalette;

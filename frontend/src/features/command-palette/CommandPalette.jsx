// Ctrl/Cmd+K command palette (UI overhaul plan §4.5, Appendix A.5). OWNER: WS-G.
//
// One dialog for everyone: "Go to" any page the viewer can open; staff also
// get Tasks and Records (GET /api/admin/search/, staff only, ≥ 2 chars,
// 150 ms debounce). ARIA combobox + listbox; arrows / Home / End / Enter /
// Esc; focus returns to whatever opened it. Recent picks live in
// localStorage when it works and are simply absent when it does not.
//
// Mount it once in the shell. It is a singleton: extra mounts (pages that
// mount it as a fallback) stay inert while another instance is active.
import { Close, Search } from "@carbon/icons-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import apiClient from "../../api/client";
import { useAuth } from "../../hooks/useAuth";
import { apiData } from "../../utils/api";
import { COMMAND_PALETTE_OPEN_EVENT } from "./events";
import {
  MIN_RECORD_QUERY,
  buildDestinations,
  buildGroups,
  buildTasks,
  flatten,
  highlightParts,
  isDocumentHref,
  readRecent,
  recordGroups,
  rememberRecent,
} from "./paletteModel";
import "./CommandPalette.scss";

export const SEARCH_DEBOUNCE_MS = 150;
const KIND_LABEL = { task: "Task", record: "Record", section: "Page", recent: "Recent" };

let activeOwner = null;

/** Only the first mounted palette is live (the shell's); others stay inert. */
function useSingleton() {
  const token = useRef(Symbol("palette"));
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    const mine = token.current;
    if (activeOwner === null) {
      activeOwner = mine;
      setOwner(true);
    }
    return () => {
      if (activeOwner === mine) activeOwner = null;
    };
  }, []);
  return owner;
}

export function useCommandPaletteState() {
  const [state, setState] = useState({ open: false, initialQuery: "" });
  useEffect(() => {
    const onOpen = (event) => setState({ open: true, initialQuery: event.detail?.initialQuery || "" });
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
  }, []);
  return [state, setState];
}

function Highlight({ text, query }) {
  return highlightParts(text, query).map((part, index) =>
    part.match ? (
      <strong key={index} className="scp-match">
        {part.text}
      </strong>
    ) : (
      <span key={index}>{part.text}</span>
    )
  );
}

function useRecordSearch(query, enabled) {
  const [state, setState] = useState({ query: "", groups: [], loading: false, error: "" });
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < MIN_RECORD_QUERY) {
      seq.current += 1;
      setState({ query: q, groups: [], loading: false, error: "" });
      return undefined;
    }
    const mine = ++seq.current;
    setState((current) => ({ ...current, loading: true, error: "" }));
    const timer = window.setTimeout(() => {
      apiClient
        .get("/admin/search/", { params: { q } })
        .then((response) => {
          if (seq.current === mine) setState({ query: q, groups: recordGroups(apiData(response, {})), loading: false, error: "" });
        })
        .catch(() => {
          if (seq.current === mine) setState({ query: q, groups: [], loading: false, error: "Records could not be searched. Pages and tasks still work." });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, enabled]);
  return state;
}

function PaletteDialog({ initialQuery, onClose, returnFocusTo }) {
  const authContext = useAuth();
  const auth = useMemo(() => authContext || {}, [authContext]);
  const navigate = useNavigate();
  const isAdmin = Boolean(auth.isAdmin);
  const userId = auth.user?.id ?? null;
  const [query, setQuery] = useState(initialQuery || "");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState(() => readRecent(userId));
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const titleId = `${baseId}-title`;

  const tasks = useMemo(() => buildTasks({ isAdmin }), [isAdmin]);
  const destinations = useMemo(() => buildDestinations(auth), [auth]);
  const records = useRecordSearch(query, isAdmin);
  const groups = useMemo(
    () => buildGroups({ query, tasks, destinations, records: records.query === query.trim() ? records.groups : [], recent }),
    [query, tasks, destinations, records, recent]
  );
  const options = useMemo(() => flatten(groups), [groups]);
  const optionId = (index) => `${baseId}-opt-${index}`;

  useEffect(() => {
    inputRef.current?.focus?.();
    inputRef.current?.select?.();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, records.groups]);

  useEffect(() => {
    const node = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const close = useCallback(() => {
    onClose();
    const target = returnFocusTo?.current;
    if (target && typeof target.focus === "function" && target.isConnected) {
      window.requestAnimationFrame(() => target.focus());
    }
  }, [onClose, returnFocusTo]);

  const choose = useCallback(
    (item) => {
      if (!item) return;
      setRecent(rememberRecent(userId, item));
      onClose();
      if (item.external) {
        window.open(item.href, "_blank", "noopener,noreferrer");
      } else if (isDocumentHref(item.href)) {
        window.location.assign(item.href);
      } else {
        navigate(item.href);
      }
    },
    [navigate, onClose, userId]
  );

  const onKeyDown = (event) => {
    const count = options.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count) setActiveIndex((index) => (index + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count) setActiveIndex((index) => (index - 1 + count) % count);
    } else if (event.key === "Home" && count) {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End" && count) {
      event.preventDefault();
      setActiveIndex(count - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(options[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      // A modal dialog with one field: keep focus inside.
      event.preventDefault();
    }
  };

  const trimmed = query.trim();
  const waitingForRecords = isAdmin && trimmed.length >= MIN_RECORD_QUERY && records.loading;
  const statusText = waitingForRecords
    ? "Searching records…"
    : options.length
      ? `${options.length} ${options.length === 1 ? "result" : "results"}`
      : trimmed
        ? "No matches"
        : "";
  let index = -1;

  return (
    <div className="scp-layer" data-command-palette="">
      <div className="scp-scrim" aria-hidden="true" onMouseDown={close} />
      <div className="scp-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="cds--visually-hidden">
          {isAdmin ? "Search people, courses, payments or jump to a page" : "Jump to a page"}
        </h2>
        <div className="scp-field">
          <Search size={20} aria-hidden="true" className="scp-field__icon" />
          <input
            ref={inputRef}
            className="scp-input"
            type="text"
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options.length ? optionId(activeIndex) : undefined}
            aria-label={isAdmin ? "Search or type an action" : "Jump to"}
            placeholder={isAdmin ? "Search people, courses, payments, or type an action" : "Jump to a page"}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="scp-close" onClick={close} aria-label="Close">
            <span className="scp-kbd" aria-hidden="true">
              Esc
            </span>
            <Close size={20} aria-hidden="true" className="scp-close__icon" />
          </button>
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="scp-list">
          {groups.map((group) => (
            <div key={group.key} role="group" aria-labelledby={`${baseId}-${group.key}`} className="scp-group">
              <div id={`${baseId}-${group.key}`} className="scp-group__label" role="presentation">
                {group.label}
              </div>
              {group.items.map((item) => {
                index += 1;
                const current = index;
                const active = current === activeIndex;
                return (
                  <div
                    key={`${group.key}-${item.id}`}
                    id={optionId(current)}
                    data-index={current}
                    role="option"
                    aria-selected={active}
                    className={`scp-option${active ? " scp-option--active" : ""}`}
                    onMouseMove={() => (active ? null : setActiveIndex(current))}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(item)}
                  >
                    <span className="scp-option__text">
                      <span className="scp-option__title">
                        <Highlight text={item.title} query={trimmed} />
                      </span>
                      {item.subtitle ? <span className="scp-option__subtitle">{item.subtitle}</span> : null}
                    </span>
                    <span className="scp-option__kind">{group.key === "recent" ? KIND_LABEL.recent : KIND_LABEL[item.kind] || ""}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {!options.length && trimmed && !waitingForRecords ? (
            <p className="scp-empty">
              Nothing matches “{trimmed}”.{isAdmin && trimmed.length < MIN_RECORD_QUERY ? " Type one more letter to search records." : ""}
            </p>
          ) : null}
        </div>
        <div className="scp-footer">
          <span className="scp-footer__status" role="status" aria-live="polite">
            {records.error || statusText}
          </span>
          <span className="scp-footer__keys" aria-hidden="true">
            <span className="scp-kbd">↑</span>
            <span className="scp-kbd">↓</span> to move <span className="scp-kbd">Enter</span> to open
          </span>
        </div>
      </div>
    </div>
  );
}

/** Keyboard shortcut: Ctrl+K / Cmd+K anywhere toggles the palette. */
export function isPaletteShortcut(event) {
  return Boolean((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === "k");
}

export default function CommandPalette() {
  const isOwner = useSingleton();
  const [state, setState] = useCommandPaletteState();
  const returnFocusTo = useRef(null);
  const auth = useAuth();
  const signedIn = Boolean(auth?.user);

  // Remember what had focus at the moment of opening (before the dialog takes it).
  const openRef = useRef(false);
  openRef.current = state.open;
  const captureFocus = useCallback(() => {
    if (openRef.current) return;
    const active = document.activeElement;
    returnFocusTo.current = active && active !== document.body ? active : null;
  }, []);

  useEffect(() => {
    if (!isOwner || !signedIn) return undefined;
    const onKey = (event) => {
      if (!isPaletteShortcut(event)) return;
      event.preventDefault();
      if (openRef.current) {
        setState({ open: false, initialQuery: "" });
        const target = returnFocusTo.current;
        if (target?.isConnected) window.requestAnimationFrame(() => target.focus?.());
        return;
      }
      captureFocus();
      setState({ open: true, initialQuery: "" });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, captureFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, captureFocus);
    };
  }, [isOwner, signedIn, setState, captureFocus]);

  const onClose = useCallback(() => setState({ open: false, initialQuery: "" }), [setState]);

  if (!isOwner || !state.open || !signedIn) return null;
  return <PaletteDialog key={state.initialQuery} initialQuery={state.initialQuery} onClose={onClose} returnFocusTo={returnFocusTo} />;
}

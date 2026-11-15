// Profile editor (Console: /profile/public). OWNER: WS-PROFILES.
// Block-based: header (name, tagline, avatar, banner, style), then the owner
// orders, shows/hides and fills the blocks (About, Badges, Skills,
// Write-ups, Gallery, Links). Draft vs published: saving never changes the
// public page; "Publish" copies the draft after the server's PII guard
// passes. The server rebuilds and checks everything; this page only edits.
// Inner app page template (PHILOSOPHY T8): golden eyebrow, h1, tab bar
// between hairlines, hairline cards.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { StatusBadge } from "../../kit/Badge";
import { Button } from "../../kit/Button";
import DisabledReason from "../../kit/DisabledReason";
import { Checkbox, Field, Input, Label, Select, Switch, Textarea } from "../../kit/Form";
import { ChevronDown, Close } from "../../kit/icons";
import { cn } from "../../kit/lib/cn";
import { Notice } from "../../kit/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../kit/Tabs";
import { Eyebrow } from "../../kit/Typography";
import { RewardRecordTabContents, RewardRecordTabTriggers, useRewardHistory } from "../rewards/RewardRecord";
import ProfileImage from "./ProfileImage";
import ProfileView from "./ProfileView";
import {
  BLOCK_META,
  formatDate,
  groupFindings,
  missingBlockTypes,
  moveBlock,
  newBlock,
  pathHasFinding,
  prefixLines,
  removeBlock,
  SKILL_LEVELS,
  toDocument,
  updateBlock,
  wrapSelection,
} from "./profileModel";
import {
  changeHandle,
  deleteProfileImage,
  fetchMyProfile,
  fetchPreview,
  publishProfile,
  readError,
  saveDraft,
  saveProfileSettings,
  unpublishProfile,
  uploadProfileImage,
} from "./profilesApi";

const card = "rounded-lg border border-white/10 bg-card";
const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

function Section({ title, hint, children, actions, className }) {
  return (
    <section className={cn(card, "p-5 sm:p-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-white">{title}</h2>
          {hint ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{hint}</p> : null}
        </div>
        {actions}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ChoiceRow({ label, value, options, onChange }) {
  const id = useId();
  return (
    <div className="space-y-2">
      <p id={id} className="text-sm font-medium text-white/[.82]">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} className="inline-grid grid-flow-col gap-1 rounded-full border border-white/10 bg-white/[.04] p-1">
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              className={cn(
                "h-9 rounded-full px-4 text-sm font-medium transition-colors duration-200 ease-standard motion-reduce:transition-none",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                active ? "bg-white text-black" : "text-muted-foreground hover:text-white"
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UploadButton({ kind, onUploaded, onError, disabled, disabledReason, children = "Upload image" }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  if (disabled) {
    return (
      <DisabledReason reason={disabledReason} size="md" look="secondary" icon="none">
        {children}
      </DisabledReason>
    );
  }
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setBusy(true);
          try {
            onUploaded(await uploadProfileImage(file, kind));
          } catch (error) {
            onError(readError(error));
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button variant="secondary" size="md" aria-disabled={busy || undefined} onClick={() => !busy && input.current?.click()}>
        {busy ? "Checking image…" : children}
      </Button>
    </>
  );
}

function ImagePicker({ label, kind, images, selected, onSelect, onUploaded, onDelete, onError, limit }) {
  const own = images.filter((image) => image.kind === kind);
  const full = own.length >= limit;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-white/[.82]">{label}</p>
        <UploadButton
          kind={kind}
          onUploaded={onUploaded}
          onError={onError}
          disabled={full}
          disabledReason={`You can keep ${limit} ${kind} images. Delete one first.`}
        />
      </div>
      {own.length ? (
        <ul className="flex flex-wrap gap-3">
          {own.map((image) => {
            const active = selected === image.id;
            return (
              <li key={image.id} className="relative">
                <button
                  type="button"
                  aria-pressed={active}
                  aria-label={active ? `${label}: in use` : `Use this ${kind} image`}
                  onClick={() => onSelect(active ? null : image.id)}
                  className={cn(
                    "block overflow-hidden border transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
                    kind === "avatar" ? "size-20 rounded-full" : "h-20 w-48 rounded-lg",
                    active ? "border-white ring-2 ring-white ring-offset-2 ring-offset-black" : "border-white/15 hover:border-white/40"
                  )}
                >
                  <ProfileImage src={image.src} alt="" className="size-full" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(image.id)}
                  aria-label={`Delete this ${kind} image`}
                  className="absolute -right-2 -top-2 inline-flex size-7 items-center justify-center rounded-full border border-white/20 bg-black text-white hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Close size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-subtle">No {kind} image yet. JPEG, PNG or WebP; location and hidden details are removed.</p>
      )}
    </div>
  );
}

function BioEditor({ block, onChange, invalid, maxLength }) {
  const area = useRef(null);
  const id = useId();
  const apply = (fn) => {
    const element = area.current;
    const start = element?.selectionStart ?? block.source.length;
    const end = element?.selectionEnd ?? block.source.length;
    const result = fn(block.source || "", start, end);
    onChange({ source: result.value });
    requestAnimationFrame(() => {
      if (!area.current) return;
      area.current.focus();
      area.current.setSelectionRange(result.start, result.end);
    });
  };
  const tools = [
    ["Bold", () => apply((v, s, e) => wrapSelection(v, s, e, "**"))],
    ["Italic", () => apply((v, s, e) => wrapSelection(v, s, e, "*"))],
    ["Code", () => apply((v, s, e) => wrapSelection(v, s, e, "`"))],
    ["Link", () => apply((v, s, e) => wrapSelection(v, s, e, "[", "](https://)", "link text"))],
    ["Heading", () => apply((v, s, e) => prefixLines(v, s, e, "### "))],
    ["List", () => apply((v, s, e) => prefixLines(v, s, e, "- "))],
    ["Quote", () => apply((v, s, e) => prefixLines(v, s, e, "> "))],
  ];
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>About text</Label>
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1">
        {tools.map(([label, run]) => (
          <Button key={label} variant="ghost" size="xs" onClick={run}>
            {label}
          </Button>
        ))}
      </div>
      <Textarea
        ref={area}
        id={id}
        rows={8}
        maxLength={maxLength}
        aria-invalid={invalid || undefined}
        value={block.source || ""}
        onChange={(event) => onChange({ source: event.target.value })}
        placeholder="What are you studying? What do you enjoy investigating?"
        className="font-mono"
      />
      <p className="flex justify-between text-xs text-subtle">
        <span>**bold** · *italic* · `code` · [link](https://…) · - list · ### heading. No HTML.</span>
        <span className="tabular-nums">
          {(block.source || "").length}/{maxLength}
        </span>
      </p>
    </div>
  );
}

function ListEditor({ items, onChange, max, addLabel, empty, render }) {
  return (
    <div className="space-y-3">
      {items.length ? (
        <ol className="space-y-3">
          {items.map((item, index) => (
            <li key={index} className="rounded-xl border border-white/10 bg-white/[.025] p-4">
              <div className="flex items-start gap-3">
                <span className="mt-2 w-6 shrink-0 font-mono text-xs tabular-nums text-subtle">{String(index + 1).padStart(2, "0")}</span>
                <div className="min-w-0 flex-1">{render(item, index, (patch) => onChange(items.map((row, at) => (at === index ? { ...row, ...patch } : row))))}</div>
                <Button variant="ghost" size="icon" aria-label={`Remove item ${index + 1}`} onClick={() => onChange(items.filter((_, at) => at !== index))}>
                  <Close size={16} />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-subtle">{empty}</p>
      )}
      {items.length < max ? (
        <Button variant="secondary" size="md" onClick={() => onChange([...items, {}])}>
          {addLabel}
        </Button>
      ) : (
        <p className="text-xs text-subtle">You reached the limit of {max}.</p>
      )}
    </div>
  );
}

function BlockBody({ block, index, me, findings, onChange, onUploaded, onDelete, onError }) {
  const limits = me.limits || {};
  const flag = (suffix) => pathHasFinding(findings, `blocks[${index}]${suffix}`);
  switch (block.type) {
    case "bio":
      return <BioEditor block={block} onChange={onChange} invalid={flag(".source")} maxLength={limits.bio || 4000} />;
    case "badges": {
      const chosen = block.badge_keys || [];
      if (!me.earned_badges?.length) return <p className="text-sm text-subtle">Earn badges in your courses, then show them here.</p>;
      return (
        <ul className="grid gap-2 sm:grid-cols-2">
          {me.earned_badges.map((badge) => {
            const checked = chosen.includes(badge.key);
            const full = !checked && chosen.length >= (limits.badges || 8);
            return (
              <li key={badge.key}>
                <label className={cn("flex min-h-11 items-center gap-3 rounded-md border border-white/10 px-4 py-2 text-sm", full ? "text-subtle" : "cursor-pointer text-white")}>
                  <Checkbox
                    checked={checked}
                    disabled={full}
                    onCheckedChange={(value) =>
                      onChange({ badge_keys: value ? [...chosen, badge.key] : chosen.filter((key) => key !== badge.key) })
                    }
                  />
                  <span>
                    {badge.title} <span className="text-xs uppercase tracking-eyebrow text-subtle">· {badge.tier}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      );
    }
    case "skills":
      return (
        <ListEditor
          items={block.items || []}
          max={limits.skills || 24}
          addLabel="Add a skill"
          empty="No skills yet."
          onChange={(items) => onChange({ items })}
          render={(item, at, patch) => (
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <Field label="Skill" error={flag(`.items[${at}].name`) ? "Remove personal details." : undefined}>
                <Input value={item.name || ""} maxLength={limits.skill_name || 40} onChange={(event) => patch({ name: event.target.value })} placeholder="e.g. Image geolocation" />
              </Field>
              <Field label="Level">
                <Select value={item.level || "learning"} onChange={(event) => patch({ level: event.target.value })}>
                  {SKILL_LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>
                      {level.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
        />
      );
    case "writeups":
      return (
        <ListEditor
          items={block.items || []}
          max={limits.writeups || 12}
          addLabel="Add a write-up"
          empty="No write-ups yet. Link to your notes on GitHub or your blog."
          onChange={(items) => onChange({ items })}
          render={(item, at, patch) => (
            <div className="grid gap-3">
              <Field label="Title" error={flag(`.items[${at}].title`) ? "Remove personal details." : undefined}>
                <Input value={item.title || ""} maxLength={limits.writeup_title || 90} onChange={(event) => patch({ title: event.target.value })} />
              </Field>
              <Field label="Link (https)" error={flag(`.items[${at}].url`) ? "Remove personal details." : undefined}>
                <Input type="url" inputMode="url" value={item.url || ""} onChange={(event) => patch({ url: event.target.value })} placeholder="https://" />
              </Field>
              <Field label="Summary" error={flag(`.items[${at}].summary`) ? "Remove personal details." : undefined}>
                <Textarea rows={3} maxLength={limits.writeup_summary || 280} value={item.summary || ""} onChange={(event) => patch({ summary: event.target.value })} />
              </Field>
              <Field label="Tags" hint="Up to 5, separated by commas.">
                <Input
                  value={(item.tags || []).join(", ")}
                  onChange={(event) =>
                    patch({
                      tags: event.target.value
                        .split(",")
                        .map((tag) => tag.trimStart())
                        .slice(0, limits.writeup_tags || 5),
                    })
                  }
                  onBlur={() => patch({ tags: (item.tags || []).map((tag) => tag.trim()).filter(Boolean) })}
                />
              </Field>
            </div>
          )}
        />
      );
    case "gallery": {
      const images = (me.images || []).filter((image) => image.kind === "gallery");
      const items = block.items || [];
      const limit = limits.gallery_images ?? 12;
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Tick the images to show, then describe them.</p>
            <UploadButton
              kind="gallery"
              onUploaded={onUploaded}
              onError={onError}
              disabled={images.length >= limit}
              disabledReason={`You can keep ${limit} gallery images. Delete one first.`}
            />
          </div>
          {images.length ? (
            <ul className="grid gap-4 sm:grid-cols-2">
              {images.map((image) => {
                const at = items.findIndex((item) => item.image_id === image.id);
                const shown = at >= 0;
                const entry = shown ? items[at] : {};
                const patch = (values) => onChange({ items: items.map((item, position) => (position === at ? { ...item, ...values } : item)) });
                return (
                  <li key={image.id} className="rounded-xl border border-white/10 bg-white/[.025] p-3">
                    <ProfileImage src={image.src} alt="" className="aspect-[4/3] rounded-lg" />
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm text-white">
                        <Checkbox
                          checked={shown}
                          onCheckedChange={(value) =>
                            onChange({ items: value ? [...items, { image_id: image.id, caption: "", alt: "" }] : items.filter((item) => item.image_id !== image.id) })
                          }
                        />
                        Show on my page
                      </label>
                      <Button variant="ghost" size="xs" onClick={() => onDelete(image.id)}>
                        Delete
                      </Button>
                    </div>
                    {shown ? (
                      <div className="mt-3 grid gap-3">
                        <Field label="Caption" error={flag(`.items[${at}].caption`) ? "Remove personal details." : undefined}>
                          <Input value={entry.caption || ""} maxLength={limits.caption || 140} onChange={(event) => patch({ caption: event.target.value })} />
                        </Field>
                        <Field label="Image description (for screen readers)">
                          <Input value={entry.alt || ""} maxLength={limits.alt || 140} onChange={(event) => patch({ alt: event.target.value })} />
                        </Field>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-subtle">No gallery images yet.</p>
          )}
        </div>
      );
    }
    case "links":
      return (
        <ListEditor
          items={block.items || []}
          max={limits.links || 8}
          addLabel="Add a link"
          empty="No links yet."
          onChange={(items) => onChange({ items })}
          render={(item, at, patch) => (
            <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
              <Field label="Label">
                <Input value={item.label || ""} maxLength={limits.link_label || 40} onChange={(event) => patch({ label: event.target.value })} placeholder="GitHub" />
              </Field>
              <Field label="Link (https)" error={flag(`.items[${at}].url`) ? "Remove personal details." : undefined}>
                <Input type="url" inputMode="url" value={item.url || ""} onChange={(event) => patch({ url: event.target.value })} placeholder="https://" />
              </Field>
            </div>
          )}
        />
      );
    default:
      return null;
  }
}

function BlockCard({ block, index, total, me, findings, onBlocks, blocks, onUploaded, onDelete, onError }) {
  const [open, setOpen] = useState(true);
  const meta = BLOCK_META[block.type] || { label: block.type };
  const bodyId = useId();
  const change = (patch) => onBlocks(updateBlock(blocks, index, patch));
  const flagged = pathHasFinding(findings, `blocks[${index}]`);
  return (
    <li className={cn(card, flagged && "border-dashed border-white/60")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3 sm:px-5">
        <span className="font-mono text-xs tabular-nums text-subtle">{String(index + 1).padStart(2, "0")}</span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="inline-flex min-h-10 items-center gap-2 rounded-md px-2 text-base font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {block.title || meta.label}
          <ChevronDown size={16} className={cn("transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        {flagged ? <StatusBadge kind="attention" label="Personal details" /> : null}
        {!block.visible ? <StatusBadge kind="disabled" label="Hidden" /> : null}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="xs" aria-label={`Move ${meta.label} up`} aria-disabled={index === 0 || undefined} onClick={() => index > 0 && onBlocks(moveBlock(blocks, index, -1))}>
            Up
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Move ${meta.label} down`}
            aria-disabled={index === total - 1 || undefined}
            onClick={() => index < total - 1 && onBlocks(moveBlock(blocks, index, 1))}
          >
            Down
          </Button>
          <label className="ml-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={block.visible !== false} onCheckedChange={(value) => change({ visible: value })} aria-label={`Show ${meta.label}`} />
            Show
          </label>
          <Button variant="ghost" size="xs" onClick={() => onBlocks(removeBlock(blocks, index))} aria-label={`Remove ${meta.label}`}>
            Remove
          </Button>
        </span>
      </div>
      {open ? (
        <div id={bodyId} className="space-y-5 p-4 sm:p-5">
          <p className="text-sm text-muted-foreground">{meta.hint}</p>
          <Field label="Section title" hint={`Leave empty to use "${meta.label}".`} error={pathHasFinding(findings, `blocks[${index}].title`) ? "Remove personal details." : undefined}>
            <Input value={block.title || ""} maxLength={me.limits?.block_title || 40} onChange={(event) => change({ title: event.target.value })} placeholder={meta.label} />
          </Field>
          <BlockBody block={block} index={index} me={me} findings={findings} onChange={change} onUploaded={onUploaded} onDelete={onDelete} onError={onError} />
        </div>
      ) : null}
    </li>
  );
}

function FindingsNotice({ message, findings, draft }) {
  const rows = groupFindings(findings, draft);
  if (!rows.length) return null;
  return (
    <div role="alert" className="rounded-lg border border-dashed border-white/60 bg-surface-1 px-5 py-5 sm:px-6">
      <Eyebrow tone="accent">Personal details found</Eyebrow>
      <p className="mt-1 text-base font-semibold text-white">{message || "Remove these before publishing."}</p>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-[#d4d4d4]">
        {rows.map((row) => (
          <li key={row.path} className="flex flex-wrap gap-x-2">
            <span className="font-medium text-white">{row.where}:</span>
            <span>{row.labels.join(", ")}</span>
            {row.excerpts.length ? <span className="font-mono text-subtle">({row.excerpts.join(", ")})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HandleForm({ me, onSaved, onError }) {
  const [value, setValue] = useState(me.handle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setValue(me.handle), [me.handle]);
  const locked = Boolean(me.next_handle_change_at);
  async function submit(event) {
    event.preventDefault();
    if (busy || value.trim().replace(/^@/, "").toLowerCase() === me.handle) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await changeHandle(value));
    } catch (failure) {
      const info = readError(failure);
      setError(info.details?.handle?.[0] || info.message);
      onError?.(info);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start" noValidate>
      <Field label="Public handle" hint="Your address: /u/handle. A nickname, never your real name." error={error || undefined}>
        <Input value={value} onChange={(event) => setValue(event.target.value)} maxLength={31} autoComplete="off" spellCheck={false} disabled={locked} />
      </Field>
      {locked ? (
        <DisabledReason className="sm:mt-7" reason={`You can change it again on ${formatDate(me.next_handle_change_at)}.`} size="md" icon="clock" look="secondary">
          Change handle
        </DisabledReason>
      ) : (
        <Button type="submit" variant="secondary" size="md" className="sm:mt-7" aria-disabled={busy || undefined}>
          {busy ? "Checking…" : "Change handle"}
        </Button>
      )}
    </form>
  );
}

export default function ProfileEditorPage() {
  // Rewards / Batches / Certificates tabs (Task C): loaded with the page so the tab opens instantly.
  const record = useRewardHistory();
  const [me, setMe] = useState(null);
  const [draft, setDraft] = useState(null);
  const [load, setLoad] = useState({ status: "loading", error: null });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null); // { tone: "ok" | "error", text }
  const [findings, setFindings] = useState([]);
  const [findingMessage, setFindingMessage] = useState("");
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => searchParams.get("tab") || "edit");
  const [preview, setPreview] = useState({ status: "idle", data: null });

  const accept = useCallback((payload, { keepDraft = false } = {}) => {
    setMe(payload);
    if (!keepDraft) {
      setDraft(payload.draft);
      setDirty(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetchMyProfile()
      .then((payload) => {
        if (!active) return;
        accept(payload);
        setLoad({ status: "ready", error: null });
      })
      .catch((error) => {
        if (active) setLoad({ status: "error", error: readError(error) });
      });
    return () => {
      active = false;
    };
  }, [accept]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const edit = (next) => {
    setDraft(next);
    setDirty(true);
  };
  const setHeader = (patch) => edit({ ...draft, header: { ...draft.header, ...patch } });
  const setTheme = (patch) => edit({ ...draft, theme: { ...draft.theme, ...patch } });
  const setBlocks = (blocks) => edit({ ...draft, blocks });
  const showError = (info) => setNotice({ tone: "error", text: info.message });

  async function save() {
    setBusy("save");
    setNotice(null);
    try {
      const payload = await saveDraft(toDocument(draft), me.draft_version);
      accept(payload);
      setFindings(payload.warnings || []);
      setFindingMessage(payload.warnings?.length ? "Saved. Remove these before you publish." : "");
      setNotice({ tone: "ok", text: "Draft saved. Your public page has not changed." });
      return payload;
    } catch (error) {
      const info = readError(error);
      setNotice({ tone: "error", text: info.code === "validation_failed" ? `${info.message} ${firstFieldError(info.details)}`.trim() : info.message });
      return null;
    } finally {
      setBusy("");
    }
  }

  async function publish() {
    if (dirty && !(await save())) return;
    setBusy("publish");
    setNotice(null);
    try {
      accept(await publishProfile());
      setFindings([]);
      setFindingMessage("");
      setNotice({ tone: "ok", text: "Published. Your page now shows this version." });
    } catch (error) {
      const info = readError(error);
      if (info.code === "pii_detected") {
        setFindings(info.details?.findings || []);
        setFindingMessage(info.message);
        setTab("edit");
      } else {
        setNotice({ tone: "error", text: info.message });
      }
    } finally {
      setBusy("");
    }
  }

  async function onUploaded(payload) {
    accept(payload, { keepDraft: true });
    const image = payload.image;
    if (image?.kind === "avatar") setHeader({ avatar_id: image.id });
    else if (image?.kind === "banner") edit({ ...draft, header: { ...draft.header, banner_id: image.id }, theme: { ...draft.theme, banner: "image" } });
    setNotice({ tone: "ok", text: "Image checked and added. Hidden details (like location) were removed." });
  }

  async function onDeleteImage(id) {
    try {
      const payload = await deleteProfileImage(id);
      setMe(payload);
      setDraft((current) => removeImageFromDraft(current, id));
      setNotice({ tone: "ok", text: "Image deleted." });
    } catch (error) {
      showError(readError(error));
    }
  }

  async function saveSetting(patch) {
    try {
      accept(await saveProfileSettings(patch), { keepDraft: true });
      setNotice({ tone: "ok", text: "Privacy settings saved." });
    } catch (error) {
      showError(readError(error));
    }
  }

  async function unpublish() {
    setBusy("unpublish");
    try {
      accept(await unpublishProfile(), { keepDraft: dirty });
      setNotice({ tone: "ok", text: "Your page is no longer published. Your draft is kept." });
    } catch (error) {
      showError(readError(error));
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    if (tab !== "preview" || !me) return;
    let active = true;
    setPreview({ status: "loading", data: null });
    fetchPreview()
      .then((data) => active && setPreview({ status: "ready", data }))
      .catch(() => active && setPreview({ status: "error", data: null }));
    return () => {
      active = false;
    };
  }, [tab, me]);

  const statusBadge = useMemo(() => {
    if (!me) return null;
    if (me.status === "hidden") return <StatusBadge kind="locked" label="Hidden by a moderator" />;
    if (me.is_published) return <StatusBadge kind="done" label="Published" />;
    return <StatusBadge kind="planned" label="Not published" />;
  }, [me]);

  if (load.status === "loading") {
    return (
      <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8" aria-busy="true">
        <span className="sr-only">Loading your profile…</span>
      </div>
    );
  }
  if (load.status === "error") {
    const off = load.error?.code === "feature_disabled";
    return (
      <div className="mx-auto w-full max-w-5xl px-5 py-10 sm:px-8">
        <Eyebrow tone="accent">Public profile</Eyebrow>
        <h1 className="mt-3 text-3xl font-bold text-white sm:text-4xl">Your profile page</h1>
        <Notice className="mt-8" eyebrow={off ? "Coming soon" : "Something went wrong"} title={off ? "Student profiles are coming soon" : "We couldn't load your profile"}>
          {off ? "Your saved profile is kept. It appears here as soon as profiles are switched on." : load.error?.message}
        </Notice>
      </div>
    );
  }

  const hidden = me.status === "hidden";
  const missing = missingBlockTypes(draft.blocks);
  const limits = me.limits || {};

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-10">
      <Eyebrow tone="accent">Public profile</Eyebrow>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white sm:text-4xl">Your profile page</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Others see exactly what you publish here, under your handle <span className="font-mono text-white">@{me.handle}</span>. Edits stay in
            your draft until you publish.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statusBadge}
          {dirty ? <StatusBadge kind="progress" label="Unsaved changes" /> : me.has_unpublished_changes && me.is_published ? <StatusBadge kind="progress" label="Draft differs" /> : null}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="md" aria-disabled={busy || !dirty || undefined} onClick={() => !busy && dirty && save()}>
          {busy === "save" ? "Saving…" : "Save draft"}
        </Button>
        {hidden ? (
          <DisabledReason reason={me.hidden_reason ? `A moderator hid your profile: ${me.hidden_reason}` : "A moderator hid your profile."} size="md" icon="lock" look="primary">
            Publish
          </DisabledReason>
        ) : (
          <Button variant="primary" size="md" trailing="chevron" aria-disabled={busy || undefined} onClick={() => !busy && publish()}>
            {busy === "publish" ? "Checking and publishing…" : "Publish"}
          </Button>
        )}
        <Button asChild variant="ghost" size="md" trailing="external">
          <Link to={me.url} target="_blank" rel="noopener">
            View my page
          </Link>
        </Button>
        {me.published_at ? <span className="text-xs text-subtle">Last published {formatDate(me.published_at)}</span> : null}
      </div>

      <div aria-live="polite" className="mt-4 min-h-6">
        {notice ? <p className={cn("text-sm", notice.tone === "error" ? "text-white" : "text-muted-foreground")}>{notice.text}</p> : null}
      </div>
      <FindingsNotice message={findingMessage} findings={findings} draft={draft} />

      <Tabs value={tab} onValueChange={setTab} className="mt-6">
        <TabsList aria-label="Profile editor">
          <TabsTrigger value="edit">Edit</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="privacy">Privacy</TabsTrigger>
          <RewardRecordTabTriggers />
        </TabsList>

        <TabsContent value="edit" className="mt-6 space-y-6">
          <Section title="Header" hint="Your display name and a short handwritten tagline sit at the top of your page.">
            <div className="grid gap-5">
              <HandleForm me={me} onSaved={(payload) => accept(payload, { keepDraft: dirty })} />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Display name" hint="A nickname is best." error={pathHasFinding(findings, "header.display_name") ? "Remove personal details." : undefined}>
                  <Input value={draft.header?.display_name || ""} maxLength={limits.display_name || 40} onChange={(event) => setHeader({ display_name: event.target.value })} />
                </Field>
                <Field label="Tagline" hint={`Up to ${limits.tagline_words || 8} words.`} error={pathHasFinding(findings, "header.tagline") ? "Remove personal details." : undefined}>
                  <Input value={draft.header?.tagline || ""} maxLength={limits.tagline || 60} onChange={(event) => setHeader({ tagline: event.target.value })} placeholder="Learning to find what others miss" />
                </Field>
              </div>
              <ImagePicker
                label="Avatar"
                kind="avatar"
                images={me.images || []}
                selected={draft.header?.avatar_id}
                limit={limits.avatar_images || 4}
                onSelect={(id) => setHeader({ avatar_id: id })}
                onUploaded={onUploaded}
                onDelete={onDeleteImage}
                onError={showError}
              />
              <ImagePicker
                label="Banner"
                kind="banner"
                images={me.images || []}
                selected={draft.header?.banner_id}
                limit={limits.banner_images || 4}
                onSelect={(id) => edit({ ...draft, header: { ...draft.header, banner_id: id }, theme: { ...draft.theme, banner: id ? "image" : "lines" } })}
                onUploaded={onUploaded}
                onDelete={onDeleteImage}
                onError={showError}
              />
            </div>
          </Section>

          <Section title="Style" hint="Black, white and one touch of golden white. Nothing else.">
            <div className="flex flex-wrap gap-6">
              <ChoiceRow label="Accent colour" value={draft.theme?.accent} onChange={(accent) => setTheme({ accent })} options={[{ value: "gold", label: "Golden white" }, { value: "white", label: "White" }]} />
              <ChoiceRow label="Alignment" value={draft.theme?.align} onChange={(align) => setTheme({ align })} options={[{ value: "center", label: "Centre" }, { value: "left", label: "Left" }]} />
              <ChoiceRow
                label="Banner style"
                value={draft.theme?.banner}
                onChange={(banner) => setTheme({ banner })}
                options={[{ value: "lines", label: "Line art" }, { value: "image", label: "My image" }, { value: "none", label: "None" }]}
              />
              <ChoiceRow label="Tagline style" value={draft.theme?.tagline} onChange={(tagline) => setTheme({ tagline })} options={[{ value: "hand", label: "Handwritten" }, { value: "plain", label: "Plain" }]} />
            </div>
          </Section>

          <div>
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 pb-4">
              <div>
                <h2 className="text-lg font-medium text-white">Blocks</h2>
                <p className="mt-1 text-sm text-muted-foreground">Your page shows them in this order.</p>
              </div>
              {missing.length ? (
                <div className="flex flex-wrap gap-2">
                  {missing.map((type) => (
                    <Button key={type} variant="secondary" size="xs" onClick={() => setBlocks([...draft.blocks, newBlock(type)])}>
                      Add {BLOCK_META[type]?.label || type}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            <ol className="mt-4 space-y-4">
              {draft.blocks.map((block, index) => (
                <BlockCard
                  key={`${block.type}-${block.id}`}
                  block={block}
                  index={index}
                  total={draft.blocks.length}
                  blocks={draft.blocks}
                  me={me}
                  findings={findings}
                  onBlocks={setBlocks}
                  onUploaded={onUploaded}
                  onDelete={onDeleteImage}
                  onError={showError}
                />
              ))}
            </ol>
          </div>
        </TabsContent>

        <TabsContent value="preview" className="mt-6">
          <p className="mb-4 text-sm text-muted-foreground">
            This is your saved draft. {dirty ? "Save to see your latest edits here." : null}
          </p>
          <div className="overflow-hidden rounded-lg border border-white/10" data-console-type="off">
            {preview.status === "ready" ? (
              <ProfileView profile={preview.data} headingLevel="h2" showReport={false} />
            ) : (
              <p className="p-6 text-sm text-subtle" aria-live="polite">
                {preview.status === "error" ? "The preview could not load." : "Loading preview…"}
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="privacy" className="mt-6 space-y-6">
          <Section title="Who can see your page">
            <ChoiceRow
              label="Visibility"
              value={me.settings?.visibility}
              onChange={(visibility) => saveSetting({ visibility })}
              options={[{ value: "members", label: "Signed-in members" }, { value: "public", label: "Anyone with the link" }]}
            />
            <p className="mt-3 text-sm text-subtle">Members only is the default. Search engines never index a members-only page.</p>
          </Section>
          <Section title="Leaderboards and names">
            <div className="space-y-5">
              {me.settings?.show_on_leaderboards === null ? (
                <p className="text-sm text-subtle">Leaderboards are not available yet.</p>
              ) : (
                <label className="flex items-center justify-between gap-4 text-sm text-white">
                  <span>
                    Show me on leaderboards
                    <span className="mt-1 block text-xs text-subtle">Off hides you from every board; you still see your own rank.</span>
                  </span>
                  <Switch checked={Boolean(me.settings?.show_on_leaderboards)} onCheckedChange={(value) => saveSetting({ show_on_leaderboards: value })} />
                </label>
              )}
              <div className="flex items-center justify-between gap-4 text-sm text-white">
                <span>
                  Show my real name
                  <span className="mt-1 block text-xs text-subtle">Profiles show your handle only unless an admin allows real names.</span>
                </span>
                {me.settings?.allow_real_names ? (
                  <Switch aria-label="Show my real name" checked={Boolean(me.settings?.show_real_name)} onCheckedChange={(value) => saveSetting({ show_real_name: value })} />
                ) : (
                  <DisabledReason reason="Real names are switched off by the admin." size="xs" icon="lock">
                    Off
                  </DisabledReason>
                )}
              </div>
            </div>
          </Section>
          <Section title="Unpublish" hint="Take your page down. Your draft and images are kept.">
            {me.is_published ? (
              <Button variant="secondary" size="md" aria-disabled={busy || undefined} onClick={() => !busy && unpublish()}>
                {busy === "unpublish" ? "Unpublishing…" : "Unpublish my page"}
              </Button>
            ) : (
              <p className="text-sm text-subtle">Your page is not published.</p>
            )}
          </Section>
          <p className="text-xs text-subtle">
            Personal details (phone, email, Aadhaar, PAN, bank, address, birth date) are blocked before publishing. Read the{" "}
            <Link className="underline underline-offset-4" to="/terms">
              terms
            </Link>
            .
          </p>
        </TabsContent>
        <RewardRecordTabContents record={record} />
      </Tabs>
    </div>
  );
}

function firstFieldError(details = {}) {
  for (const [key, value] of Object.entries(details)) {
    if (["code", "detail", "findings"].includes(key)) continue;
    if (Array.isArray(value) && value.length) return String(value[0]);
  }
  return "";
}

function removeImageFromDraft(draft, id) {
  if (!draft) return draft;
  const header = { ...draft.header };
  if (header.avatar_id === id) header.avatar_id = null;
  if (header.banner_id === id) header.banner_id = null;
  return {
    ...draft,
    header,
    blocks: draft.blocks.map((block) => (block.type === "gallery" ? { ...block, items: (block.items || []).filter((item) => item.image_id !== id) } : block)),
  };
}

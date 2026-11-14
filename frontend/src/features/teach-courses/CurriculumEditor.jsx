// Course editor › Curriculum (UI overhaul plan §3.5). OWNER: WS-D2.
// Modules and lectures in order. Reorder by drag (pointer), by the Move
// buttons, or from the keyboard with Alt+↑ / Alt+↓ on a focused row; every
// move is announced. Deletes confirm and name the object.
import { Add, ArrowDown, ArrowUp, Draggable, Edit, TrashCan } from "@carbon/icons-react";
import { Button, Checkbox, IconButton, InlineLoading, TextArea, TextInput } from "@carbon/react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, DropZone, EmptyState, useToast } from "../app-shell/ui";
import { apiMessage } from "../../utils/api";
import {
  buildLecturePayload,
  EMPTY_LECTURE_FORM,
  lectureUpdatePayload,
  moveItem,
  renumber,
  reorderKeyTarget,
  sectionUpdatePayload,
  validateLectureForm,
} from "./courseModel";
import { createLecture, createSection, deleteLecture, deleteSection, saveLecture, saveSection } from "./teachCoursesApi";

const VIDEO_TYPES = "video/mp4,video/webm,video/quicktime,video/x-matroska";

function sortByOrder(items = []) {
  return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);
}

function sectionsOf(course) {
  return sortByOrder(course?.sections || []).map((section) => ({ ...section, lectures: sortByOrder(section.lectures || []) }));
}

function MoveButtons({ label, index, length, disabled, onMove }) {
  return (
    <span className="tch-move">
      <IconButton kind="ghost" size="sm" label={`Move ${label} up`} align="top" disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)}>
        <ArrowUp />
      </IconButton>
      <IconButton kind="ghost" size="sm" label={`Move ${label} down`} align="top" disabled={disabled || index === length - 1} onClick={() => onMove(index, index + 1)}>
        <ArrowDown />
      </IconButton>
    </span>
  );
}

/** Drag-and-drop for a list of rows (pointer only; the keyboard path is Alt+arrows). */
function useDragList(onMove) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const rowProps = (index, enabled) =>
    enabled
      ? {
          draggable: true,
          onDragStart: (event) => {
            event.stopPropagation();
            setDragIndex(index);
            try {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", String(index));
            } catch {
              // Some browsers refuse custom data; the index is kept in state.
            }
          },
          onDragOver: (event) => {
            if (dragIndex === null) return;
            event.preventDefault();
            event.stopPropagation();
            if (overIndex !== index) setOverIndex(index);
          },
          onDrop: (event) => {
            if (dragIndex === null) return;
            event.preventDefault();
            event.stopPropagation();
            const from = dragIndex;
            setDragIndex(null);
            setOverIndex(null);
            if (from !== index) onMove(from, index);
          },
          onDragEnd: () => {
            setDragIndex(null);
            setOverIndex(null);
          },
          "data-dragging": dragIndex === index ? "true" : undefined,
          "data-drop-target": overIndex === index && dragIndex !== null && dragIndex !== index ? "true" : undefined,
        }
      : {};
  return rowProps;
}

function LectureForm({ idPrefix, busy, onSubmit, onCancel }) {
  const [form, setForm] = useState({ ...EMPTY_LECTURE_FORM });
  const [errors, setErrors] = useState({});
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const submit = (event) => {
    event.preventDefault();
    const found = validateLectureForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    onSubmit(form);
  };
  return (
    <form className="tch-inline-form" onSubmit={submit} noValidate aria-label="New lecture">
      <TextInput id={`${idPrefix}-title`} labelText="Lecture title" value={form.title} invalid={Boolean(errors.title)} invalidText={errors.title} onChange={(event) => set({ title: event.target.value })} />
      <div className="tch-video">
        {form.video_file ? (
          <p className="tch-video__file">
            {form.video_file.name}
            <Button kind="ghost" size="sm" onClick={() => set({ video_file: null })}>
              Remove
            </Button>
          </p>
        ) : (
          <DropZone accept={VIDEO_TYPES} label="Lecture video" onFiles={(files) => files?.[0] && set({ video_file: files[0] })} />
        )}
        <TextInput
          id={`${idPrefix}-key`}
          labelText="Or a storage key or video link"
          helperText="Used when you do not upload a file."
          value={form.video_key}
          disabled={Boolean(form.video_file)}
          onChange={(event) => set({ video_key: event.target.value })}
        />
        {errors.video ? (
          <p className="tch-field-error" role="alert">
            {errors.video}
          </p>
        ) : null}
      </div>
      <TextArea id={`${idPrefix}-description`} labelText="Description (optional)" rows={2} value={form.description} onChange={(event) => set({ description: event.target.value })} />
      <Checkbox id={`${idPrefix}-preview`} labelText="Free preview (anyone can watch it)" checked={form.is_preview} onChange={(_event, { checked }) => set({ is_preview: checked })} />
      <div className="tch-inline-form__actions">
        <Button kind="secondary" size="md" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button kind="primary" size="md" type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add lecture"}
        </Button>
      </div>
      {busy && form.video_file ? <InlineLoading description="Uploading the video. Keep this page open." /> : null}
    </form>
  );
}

function ModuleForm({ initial, submitLabel, busy, onSubmit, onCancel, idPrefix }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [error, setError] = useState("");
  return (
    <form
      className="tch-inline-form"
      noValidate
      aria-label={submitLabel}
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) {
          setError("Give the module a title.");
          return;
        }
        onSubmit({ title: title.trim(), description: description.trim() });
      }}
    >
      <TextInput id={`${idPrefix}-title`} labelText="Module title" value={title} invalid={Boolean(error)} invalidText={error} onChange={(event) => setTitle(event.target.value)} />
      <TextArea id={`${idPrefix}-description`} labelText="What it covers (optional)" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
      <div className="tch-inline-form__actions">
        {onCancel ? (
          <Button kind="secondary" size="md" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button kind="primary" size="md" type="submit" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function LectureRow({ lecture, index, length, canEdit, busy, onMove, onTogglePreview, onDelete, dragProps }) {
  return (
    <li
      className="tch-lecture"
      tabIndex={canEdit ? 0 : undefined}
      aria-label={canEdit ? `Lecture ${index + 1} of ${length}: ${lecture.title}. Alt plus arrow keys move it.` : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const target = reorderKeyTarget(event, index, length);
        if (target === null) return;
        event.preventDefault();
        onMove(index, target, { refocus: true });
      }}
      {...dragProps}
    >
      {canEdit ? <Draggable size={16} aria-hidden="true" className="tch-handle" /> : null}
      <span className="tch-lecture__index" aria-hidden="true">
        {index + 1}
      </span>
      <span className="tch-lecture__text">
        <span className="tch-lecture__title">{lecture.title}</span>
        {lecture.stream_status && lecture.stream_status !== "ready" && lecture.stream_status !== "none" ? (
          <span className="tch-muted">Video {String(lecture.stream_status).replace(/_/g, " ")}</span>
        ) : null}
      </span>
      {canEdit ? (
        <span className="tch-lecture__actions">
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(lecture.is_preview)}
            className="tch-switch"
            disabled={busy}
            onClick={() => onTogglePreview(lecture)}
          >
            <span className="tch-switch__track" aria-hidden="true">
              <span className="tch-switch__knob" />
            </span>
            <span className="tch-switch__label">Free preview</span>
          </button>
          <MoveButtons label={lecture.title} index={index} length={length} disabled={busy} onMove={onMove} />
          <IconButton kind="ghost" size="sm" label={`Delete ${lecture.title}`} align="top-end" disabled={busy} onClick={() => onDelete(lecture)}>
            <TrashCan />
          </IconButton>
        </span>
      ) : lecture.is_preview ? (
        <span className="tch-tag">Free preview</span>
      ) : null}
    </li>
  );
}

function ModuleCard({ courseId, section, index, length, canEdit, busy, onMove, onChanged, onDeleteModule, onDeleteLecture, setBusy, announce, dragProps }) {
  const { showToast } = useToast();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [lectures, setLectures] = useState(section.lectures);
  const lectureRefs = useRef(new Map());
  useEffect(() => setLectures(section.lectures), [section.lectures]);

  const moveLecture = async (from, to, { refocus = false } = {}) => {
    const moved = moveItem(lectures, from, to);
    const { items, changed } = renumber(moved);
    const previous = lectures;
    setLectures(items);
    announce(`Moved “${items[to].title}” to position ${to + 1} of ${items.length}.`);
    if (refocus) window.requestAnimationFrame(() => lectureRefs.current.get(items[to].id)?.focus());
    if (!changed.length) return;
    setBusy(true);
    try {
      await Promise.all(changed.map(({ id, order }) => saveLecture(id, lectureUpdatePayload(section.id, items.find((item) => item.id === id), { order }))));
      onChanged({ quiet: true });
    } catch (error) {
      setLectures(previous);
      showToast({ kind: "error", title: "The new order was not saved.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const togglePreview = async (lecture) => {
    setBusy(true);
    const next = !lecture.is_preview;
    setLectures((current) => current.map((item) => (item.id === lecture.id ? { ...item, is_preview: next } : item)));
    try {
      await saveLecture(lecture.id, lectureUpdatePayload(section.id, lecture, { is_preview: next }));
      announce(next ? `“${lecture.title}” is a free preview.` : `“${lecture.title}” is for enrolled students only.`);
      onChanged({ quiet: true });
    } catch (error) {
      setLectures((current) => current.map((item) => (item.id === lecture.id ? { ...item, is_preview: !next } : item)));
      showToast({ kind: "error", title: "Not saved.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const addLecture = async (form) => {
    setBusy(true);
    try {
      await createLecture(buildLecturePayload(section.id, form, lectures.length + 1));
      setAdding(false);
      showToast({ kind: "success", title: "Lecture added" });
      onChanged();
    } catch (error) {
      showToast({ kind: "error", title: "The lecture was not added.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const rename = async ({ title, description }) => {
    setBusy(true);
    try {
      await saveSection(section.id, sectionUpdatePayload(courseId, section, { title, description }));
      setRenaming(false);
      showToast({ kind: "success", title: "Module saved" });
      onChanged();
    } catch (error) {
      showToast({ kind: "error", title: "Not saved.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const lectureDrag = useDragList((from, to) => moveLecture(from, to));
  const label = `module ${section.title}`;

  return (
    <li className="tch-module" {...dragProps}>
      <div
        className="tch-module__head"
        tabIndex={canEdit ? 0 : undefined}
        aria-label={canEdit ? `Module ${index + 1} of ${length}: ${section.title}. Alt plus arrow keys move it.` : undefined}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const target = reorderKeyTarget(event, index, length);
          if (target === null) return;
          event.preventDefault();
          onMove(index, target, { refocus: true });
        }}
        data-module-head={section.id}
      >
        {canEdit ? <Draggable size={16} aria-hidden="true" className="tch-handle" /> : null}
        <div className="tch-module__text">
          <h3 className="tch-module__title">
            <span className="tch-module__index">{index + 1}</span>
            {section.title}
          </h3>
          <p className="tch-muted">
            {lectures.length} {lectures.length === 1 ? "lecture" : "lectures"}
            {section.description ? ` · ${section.description}` : ""}
          </p>
        </div>
        {canEdit ? (
          <span className="tch-module__actions">
            <MoveButtons label={label} index={index} length={length} disabled={busy} onMove={onMove} />
            <IconButton kind="ghost" size="sm" label={`Rename ${label}`} align="top" disabled={busy} onClick={() => setRenaming((value) => !value)}>
              <Edit />
            </IconButton>
            <IconButton kind="ghost" size="sm" label={`Delete ${label}`} align="top-end" disabled={busy} onClick={() => onDeleteModule(section)}>
              <TrashCan />
            </IconButton>
          </span>
        ) : null}
      </div>
      {renaming ? <ModuleForm idPrefix={`tch-module-${section.id}`} initial={section} submitLabel="Save module" busy={busy} onSubmit={rename} onCancel={() => setRenaming(false)} /> : null}
      {lectures.length ? (
        <ol className="tch-lectures" aria-label={`Lectures in ${section.title}`}>
          {lectures.map((lecture, lectureIndex) => (
            <LectureRow
              key={lecture.id}
              lecture={lecture}
              index={lectureIndex}
              length={lectures.length}
              canEdit={canEdit}
              busy={busy}
              onMove={moveLecture}
              onTogglePreview={togglePreview}
              onDelete={(item) => onDeleteLecture(item, section)}
              dragProps={{
                ...lectureDrag(lectureIndex, canEdit && !busy),
                ref: (node) => (node ? lectureRefs.current.set(lecture.id, node) : lectureRefs.current.delete(lecture.id)),
              }}
            />
          ))}
        </ol>
      ) : (
        <p className="tch-muted tch-module__empty">No lectures yet.</p>
      )}
      {canEdit ? (
        adding ? (
          <LectureForm idPrefix={`tch-lecture-${section.id}`} busy={busy} onSubmit={addLecture} onCancel={() => setAdding(false)} />
        ) : (
          <Button kind="ghost" size="md" renderIcon={Add} className="tch-add" disabled={busy} onClick={() => setAdding(true)}>
            Add lecture
          </Button>
        )
      ) : null}
    </li>
  );
}

/**
 * `course` is the API detail (sections with lectures); `onChanged()` reloads
 * it (`{ quiet: true }` when the change is already on screen).
 */
export default function CurriculumEditor({ course, canEdit, onChanged }) {
  const { showToast } = useToast();
  const [sections, setSections] = useState(() => sectionsOf(course));
  const [busy, setBusy] = useState(false);
  const [addingModule, setAddingModule] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef(null);
  useEffect(() => setSections(sectionsOf(course)), [course]);

  const announce = (text) => setAnnouncement(text);

  const moveModule = async (from, to, { refocus = false } = {}) => {
    const moved = moveItem(sections, from, to);
    const { items, changed } = renumber(moved);
    const previous = sections;
    setSections(items);
    announce(`Moved “${items[to].title}” to position ${to + 1} of ${items.length}.`);
    if (refocus) {
      window.requestAnimationFrame(() => listRef.current?.querySelector(`[data-module-head="${items[to].id}"]`)?.focus());
    }
    if (!changed.length) return;
    setBusy(true);
    try {
      await Promise.all(changed.map(({ id, order }) => saveSection(id, sectionUpdatePayload(course.id, items.find((item) => item.id === id), { order }))));
      onChanged?.({ quiet: true });
    } catch (error) {
      setSections(previous);
      showToast({ kind: "error", title: "The new order was not saved.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const addModule = async ({ title, description }) => {
    setBusy(true);
    try {
      await createSection({ course: Number(course.id), title, description, order: sections.length + 1 });
      setAddingModule(false);
      showToast({ kind: "success", title: "Module added" });
      onChanged?.();
    } catch (error) {
      showToast({ kind: "error", title: "The module was not added.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "module") await deleteSection(confirm.item.id);
      else await deleteLecture(confirm.item.id);
      showToast({ kind: "success", title: confirm.kind === "module" ? "Module deleted" : "Lecture deleted" });
      setConfirm(null);
      onChanged?.();
    } catch (error) {
      showToast({ kind: "error", title: "Not deleted.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
    }
  };

  const moduleDrag = useDragList((from, to) => moveModule(from, to));

  return (
    <section className="tch-curriculum" aria-labelledby="tch-curriculum-title">
      <div className="tch-section-head">
        <h2 id="tch-curriculum-title" className="tch-section-title">
          Curriculum
        </h2>
        {canEdit && sections.length > 1 ? <p className="tch-muted tch-hint">Drag a row, or focus it and press Alt + ↑ / ↓ to move it.</p> : null}
      </div>
      <p className="cds--visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {sections.length ? (
        <ol className="tch-modules" ref={listRef}>
          {sections.map((section, index) => (
            <ModuleCard
              key={section.id}
              courseId={course.id}
              section={section}
              index={index}
              length={sections.length}
              canEdit={canEdit}
              busy={busy}
              setBusy={setBusy}
              announce={announce}
              onMove={moveModule}
              onChanged={onChanged}
              onDeleteModule={(item) => setConfirm({ kind: "module", item })}
              onDeleteLecture={(item) => setConfirm({ kind: "lecture", item })}
              dragProps={moduleDrag(index, canEdit && !busy)}
            />
          ))}
        </ol>
      ) : (
        <EmptyState
          icon={Add}
          title={canEdit ? "Start with a module." : "No modules yet."}
          body={canEdit ? "Modules group lectures, for example “Week 1: Search basics”." : undefined}
        />
      )}
      {canEdit ? (
        addingModule || !sections.length ? (
          <ModuleForm idPrefix="tch-new-module" submitLabel="Add module" busy={busy} onSubmit={addModule} onCancel={sections.length ? () => setAddingModule(false) : null} />
        ) : (
          <Button kind="tertiary" size="md" renderIcon={Add} className="tch-add" disabled={busy} onClick={() => setAddingModule(true)}>
            Add module
          </Button>
        )
      ) : null}
      <ConfirmDialog
        open={Boolean(confirm)}
        danger
        title={confirm?.kind === "module" ? "Delete this module?" : "Delete this lecture?"}
        objectName={confirm?.item?.title}
        body={
          confirm?.kind === "module"
            ? `Its ${confirm.item.lectures?.length || 0} lecture(s) are deleted too. Students lose access to them. This can't be undone.`
            : "Students lose access to it and its progress. This can't be undone."
        }
        confirmLabel={busy ? "Deleting…" : "Delete"}
        onConfirm={runDelete}
        onCancel={() => !busy && setConfirm(null)}
      />
    </section>
  );
}

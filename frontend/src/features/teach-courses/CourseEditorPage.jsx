// Course editor (UI overhaul plan §3.5; T3 detail with tabs Overview ·
// Curriculum · Live classes) and New course (T4 form). OWNER: WS-D2.
// Replaces the legacy Tailwind Create / Edit course pages.
//
// Unsaved Overview edits are kept on this device (sessionStorage) while they
// are unsaved, so a "Teaching was switched off" swap (FeatureGate) or a
// reload never loses them; they come back with a "Restored" note.
import "./TeachCourses.scss";

import { View } from "@carbon/icons-react";
import { Button, InlineNotification } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ConfirmDialog,
  DisabledReason,
  ErrorState,
  NotFoundState,
  PageHeader,
  PageSkeleton,
  ScrollTabs,
  StatusTag,
  StickyActionBar,
  T3Detail,
  T4Form,
  useToast,
} from "../app-shell/ui";
import { CAPABILITIES_STALE_EVENT } from "../capabilities";
import { useAuth } from "../../hooks/useAuth";
import { apiData, apiMessage } from "../../utils/api";
import { useWorkspaceRoot } from "../grading/workspaceRoot";
import CourseLiveClasses from "./CourseLiveClasses";
import CourseOverviewForm from "./CourseOverviewForm";
import {
  buildCoursePayload,
  clearCourseDraft,
  courseToForm,
  curriculumCounts,
  describeCurriculum,
  EMPTY_COURSE_FORM,
  isCourseFormDirty,
  loadCourseDraft,
  publishBlocker,
  saveCourseDraft,
  validateCourseForm,
} from "./courseModel";
import CurriculumEditor from "./CurriculumEditor";
import { createCourse, getCourse, updateCourse } from "./teachCoursesApi";

/** A calm inline note with an optional plain action (no "retry" icon). */
function Notice({ kind = "info", title, subtitle, action }) {
  return (
    <div className="tch-notice">
      <InlineNotification lowContrast hideCloseButton kind={kind} title={title} subtitle={subtitle} role={kind === "error" ? "alert" : "status"} />
      {action}
    </div>
  );
}

export const EDITOR_TABS = Object.freeze([
  { key: "overview", label: "Overview" },
  { key: "curriculum", label: "Curriculum" },
  { key: "live", label: "Live classes" },
]);

/** The viewer may author this course: its instructor (the API refuses everyone else). */
export function canAuthorCourse(user, course) {
  if (!user || user.role !== "instructor") return false;
  if (!course) return true;
  return Number(course.instructor?.id) === Number(user.id);
}

function serverFieldErrors(error) {
  const errors = error?.response?.data?.errors;
  if (!errors || typeof errors !== "object") return {};
  const result = {};
  Object.entries(errors).forEach(([key, value]) => {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && ["title", "description", "price", "thumbnail", "thumbnail_file"].includes(key)) {
      result[key === "thumbnail_file" ? "thumbnail" : key] = first;
    }
  });
  return result;
}

/** Keeps unsaved text edits on this device and warns before leaving the page. */
function useDraftKeeper(draftId, form, saved, enabled) {
  const dirty = enabled && isCourseFormDirty(form, saved);
  useEffect(() => {
    if (!enabled) return;
    if (dirty) saveCourseDraft(draftId, form);
    else clearCourseDraft(draftId);
  }, [draftId, form, dirty, enabled]);
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return undefined;
    const keep = () => saveCourseDraft(draftId, form);
    const warn = (event) => {
      keep();
      event.preventDefault();
      event.returnValue = "";
    };
    // A "feature_disabled" answer swaps this page out: flush the draft first.
    window.addEventListener(CAPABILITIES_STALE_EVENT, keep);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener(CAPABILITIES_STALE_EVENT, keep);
      window.removeEventListener("beforeunload", warn);
    };
  }, [draftId, form, dirty]);
  return dirty;
}

function NewCourse({ root }) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const auth = useAuth() || {};
  const [form, setForm] = useState(() => {
    const draft = loadCourseDraft("new");
    return draft ? { ...EMPTY_COURSE_FORM, ...draft } : { ...EMPTY_COURSE_FORM };
  });
  const [restored] = useState(() => Boolean(loadCourseDraft("new")));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canCreate = canAuthorCourse(auth.user, null);
  useDraftKeeper("new", form, EMPTY_COURSE_FORM, canCreate);

  const submit = async (event) => {
    event.preventDefault();
    const found = validateCourseForm(form);
    setErrors(found);
    setError("");
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const course = apiData(await createCourse(buildCoursePayload({ ...form, is_published: false })), {});
      clearCourseDraft("new");
      showToast({ kind: "success", title: "Course created", subtitle: "Add modules and lectures next." });
      navigate(`${root}/courses/${course.id}?tab=curriculum`, { replace: true });
    } catch (err) {
      setErrors(serverFieldErrors(err));
      setError(apiMessage(err, "The course was not created. Try again."));
      setSaving(false);
    }
  };

  const header = (
    <PageHeader
      eyebrow={null}
      breadcrumbs={[{ label: "Courses", href: `${root}/courses` }]}
      title="New course"
      description="Start with the basics. You add modules and lectures next; it stays a draft until you publish."
    />
  );

  if (!canCreate) {
    return (
      <div className="tch-page">
        {header}
        <Notice
          title="Courses are created by instructors."
          subtitle="Staff add courses in the back office."
          action={
            <Button kind="tertiary" size="md" href="/admin/courses/course/add/">
              Add a course in the back office
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="tch-page">
      <form onSubmit={submit} noValidate>
        <T4Form
          header={header}
          main={
            <>
              {restored ? <Notice title="Restored your unsaved changes from this device." /> : null}
              {error ? <Notice kind="error" title="Not created." subtitle={error} /> : null}
              <CourseOverviewForm form={form} setForm={setForm} errors={errors} />
            </>
          }
          actions={
            <StickyActionBar
              dirty={isCourseFormDirty(form, EMPTY_COURSE_FORM)}
              secondary={
                <Button as={Link} to={`${root}/courses`} kind="secondary">
                  Cancel
                </Button>
              }
              primary={
                <Button type="submit" kind="primary" className="sc-button--accent" disabled={saving}>
                  {saving ? "Creating…" : "Create course"}
                </Button>
              }
            />
          }
        />
      </form>
    </div>
  );
}

function PublishControl({ course, canEdit, busy, onPublish, onUnpublish }) {
  if (!canEdit) return null;
  if (course.is_published) {
    return (
      <Button kind="ghost" disabled={busy} onClick={onUnpublish}>
        Unpublish
      </Button>
    );
  }
  const blocker = publishBlocker(course);
  if (blocker) {
    return (
      <DisabledReason as="span" reason={blocker} className="tch-disabled-action">
        Publish course
      </DisabledReason>
    );
  }
  return (
    <Button kind="primary" className="sc-button--accent" disabled={busy} onClick={onPublish}>
      Publish course
    </Button>
  );
}

function EditCourse({ id, root }) {
  const [params] = useSearchParams();
  const { showToast } = useToast();
  const auth = useAuth() || {};
  const tab = EDITOR_TABS.some((item) => item.key === params.get("tab")) ? params.get("tab") : "overview";
  const [state, setState] = useState({ course: null, loading: true, error: "", missing: false });
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [restored, setRestored] = useState(false);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  const load = useCallback(
    ({ quiet = false, keepForm = true } = {}) => {
      if (!quiet) setState((current) => ({ ...current, loading: !current.course, error: "" }));
      return getCourse(id)
        .then((response) => {
          const course = apiData(response, null);
          const nextSaved = courseToForm(course);
          setState({ course, loading: false, error: "", missing: false });
          setSaved(nextSaved);
          setForm((current) => {
            if (current && keepForm) return current;
            const draft = loadCourseDraft(id);
            if (draft && isCourseFormDirty({ ...nextSaved, ...draft }, nextSaved)) {
              setRestored(true);
              return { ...nextSaved, ...draft, thumbnail_file: null };
            }
            return nextSaved;
          });
        })
        .catch((error) => {
          const status = error?.response?.status;
          setState({ course: null, loading: false, error: apiMessage(error, "Please try again."), missing: status === 404 || status === 403 });
        });
    },
    [id]
  );

  useEffect(() => {
    setForm(null);
    load({ keepForm: false });
  }, [load]);

  const course = state.course;
  const canEdit = canAuthorCourse(auth.user, course);
  const dirty = useDraftKeeper(id, form, saved, canEdit && Boolean(form));

  const saveOverview = async (event) => {
    event.preventDefault();
    const found = validateCourseForm(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      await updateCourse(id, buildCoursePayload({ ...form, is_published: Boolean(course?.is_published) }));
      clearCourseDraft(id);
      setRestored(false);
      showToast({ kind: "success", title: "Saved" });
      setForm(null);
      await load({ quiet: true, keepForm: false });
    } catch (err) {
      setErrors(serverFieldErrors(err));
      showToast({ kind: "error", title: "Not saved.", subtitle: apiMessage(err, "Try again.") });
    } finally {
      setSaving(false);
    }
  };

  const setPublished = async (value) => {
    setPublishing(true);
    try {
      const payload = new FormData();
      payload.append("is_published", value ? "true" : "false");
      await updateCourse(id, payload);
      showToast({ kind: "success", title: value ? "Published" : "Unpublished", subtitle: value ? "Students can find and open it now." : "It is a draft again." });
      await load({ quiet: true });
    } catch (err) {
      showToast({ kind: "error", title: "That didn't work.", subtitle: apiMessage(err, "Try again.") });
    } finally {
      setPublishing(false);
      setConfirmUnpublish(false);
    }
  };

  const tabs = useMemo(() => EDITOR_TABS.map((item) => ({ key: item.key, label: item.label, href: `?tab=${item.key}` })), []);

  if (state.missing) {
    return <NotFoundState title="This course does not exist" body="It may have been deleted, or it belongs to someone else." backHref={`${root}/courses`} backLabel="Back to Courses" />;
  }
  if (state.loading || !form) {
    return state.error ? (
      <ErrorState error={`Couldn't load this course. ${state.error}`} onRetry={() => load({ keepForm: false })} />
    ) : (
      <PageSkeleton label="Loading course" count={3} />
    );
  }

  const counts = curriculumCounts(course);
  const header = (
    <PageHeader
      eyebrow={null}
      breadcrumbs={[{ label: "Courses", href: `${root}/courses` }]}
      title={course.title || "Edit course"}
      description={describeCurriculum(counts)}
      actions={
        <span className="tch-header-actions">
          <StatusTag status={course.is_published ? "published" : "draft"} />
          {course.is_published ? (
            <Button as={Link} to={`/courses/${course.id}`} kind="ghost" renderIcon={View}>
              View page
            </Button>
          ) : null}
          <PublishControl course={course} canEdit={canEdit} busy={publishing} onPublish={() => setPublished(true)} onUnpublish={() => setConfirmUnpublish(true)} />
        </span>
      }
    />
  );

  let main;
  if (tab === "curriculum") main = <CurriculumEditor course={course} canEdit={canEdit} onChanged={(options) => load({ quiet: Boolean(options?.quiet) })} />;
  else if (tab === "live") main = <CourseLiveClasses course={course} classesHref={`${root}/classes`} />;
  else {
    main = (
      <form onSubmit={saveOverview} noValidate className="tch-overview">
        {restored ? (
          <Notice
            title="Restored your unsaved changes from this device."
            action={
              <Button
                kind="ghost"
                size="md"
                onClick={() => {
                  clearCourseDraft(id);
                  setRestored(false);
                  setForm(saved);
                }}
              >
                Discard them
              </Button>
            }
          />
        ) : null}
        <CourseOverviewForm form={form} setForm={setForm} errors={errors} readOnly={!canEdit} currentThumbnail={course.thumbnail || ""} course={course} />
        {canEdit ? (
          <StickyActionBar
            dirty={dirty}
            secondary={
              dirty ? (
                <Button kind="ghost" disabled={saving} onClick={() => setForm(saved)}>
                  Discard changes
                </Button>
              ) : null
            }
            primary={
              <Button type="submit" kind="primary" disabled={saving || !dirty}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            }
          />
        ) : null}
      </form>
    );
  }

  return (
    <div className="tch-page">
      <T3Detail
        header={
          <>
            {header}
            {!canEdit ? (
              <Notice
                title="Only the course's instructor edits it here."
                subtitle="Staff change course details, pricing and page copy in the back office."
                action={
                  <Button kind="tertiary" size="md" href={`/admin/courses/course/${encodeURIComponent(course.id)}/change/`}>
                    Open in back office
                  </Button>
                }
              />
            ) : null}
            <ScrollTabs label="Course sections" activeKey={tab} tabs={tabs} />
          </>
        }
        main={<div className="tch-tab-body">{main}</div>}
      />
      <ConfirmDialog
        open={confirmUnpublish}
        title="Unpublish this course?"
        objectName={course.title}
        body="It leaves the catalogue and students can no longer open it until you publish it again."
        confirmLabel={publishing ? "Working…" : "Unpublish"}
        danger
        onConfirm={() => setPublished(false)}
        onCancel={() => !publishing && setConfirmUnpublish(false)}
      />
    </div>
  );
}

export default function CourseEditorPage() {
  const { id } = useParams();
  const root = useWorkspaceRoot();
  return id ? <EditCourse key={id} id={id} root={root} /> : <NewCourse root={root} />;
}

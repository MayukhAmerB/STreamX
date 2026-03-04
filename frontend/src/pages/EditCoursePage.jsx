import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  createLecture,
  createSection,
  deleteLecture,
  deleteSection,
  getCourse,
  updateSection,
  updateCourse,
} from "../api/courses";
import Button from "../components/Button";
import WorkflowGuidePanel from "../components/admin/WorkflowGuidePanel";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { apiData, apiMessage } from "../utils/api";
import { CourseForm } from "./CreateCoursePage";

export default function EditCoursePage() {
  const { id } = useParams();
  const [course, setCourse] = useState(null);
  const [courseForm, setCourseForm] = useState(null);
  const [sectionDraft, setSectionDraft] = useState({ title: "", description: "" });
  const [sectionEdits, setSectionEdits] = useState({});
  const [lectureForms, setLectureForms] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadCourse = async () => {
    const response = await getCourse(id);
    const data = apiData(response);
    setCourse(data);
    setCourseForm({
      title: data.title || "",
      description: data.description || "",
      price: data.price || "",
      thumbnail: data.thumbnail || "",
      is_published: Boolean(data.is_published),
    });
    setSectionEdits((prev) => {
      const next = { ...prev };
      (data.sections || []).forEach((section) => {
        next[section.id] = {
          title: section.title || "",
          description: section.description || "",
        };
      });
      return next;
    });
  };

  useEffect(() => {
    (async () => {
      try {
        await loadCourse();
      } catch (err) {
        setError(apiMessage(err, "Failed to load course."));
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const sectionCount = useMemo(() => course?.sections?.length || 0, [course]);

  const handleSaveCourse = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await updateCourse(id, { ...courseForm, price: Number(courseForm.price) });
      await loadCourse();
      setMessage("Course updated.");
    } catch (err) {
      setError(apiMessage(err, "Failed to update course."));
    } finally {
      setSaving(false);
    }
  };

  const handleAddSection = async () => {
    if (!sectionDraft.title.trim()) return;
    setError("");
    try {
      await createSection({
        course: Number(id),
        title: sectionDraft.title.trim(),
        description: sectionDraft.description.trim(),
        order: sectionCount + 1,
      });
      setSectionDraft({ title: "", description: "" });
      await loadCourse();
    } catch (err) {
      setError(apiMessage(err, "Failed to add section."));
    }
  };

  const handleSaveSection = async (section) => {
    const edit = sectionEdits[section.id];
    if (!edit?.title?.trim()) return;
    setError("");
    setMessage("");
    try {
      await updateSection(section.id, {
        course: Number(id),
        title: edit.title.trim(),
        description: (edit.description || "").trim(),
        order: section.order,
      });
      await loadCourse();
      setMessage(`Module "${edit.title.trim()}" updated.`);
    } catch (err) {
      setError(apiMessage(err, "Failed to update section."));
    }
  };

  const handleDeleteSection = async (sectionId) => {
    try {
      await deleteSection(sectionId);
      await loadCourse();
    } catch (err) {
      setError(apiMessage(err, "Failed to delete section."));
    }
  };

  const handleAddLecture = async (section) => {
    const currentForm = lectureForms[section.id];
    if (!currentForm?.title || !currentForm?.video_key) return;
    try {
      await createLecture({
        section: section.id,
        title: currentForm.title,
        description: currentForm.description || "",
        video_key: currentForm.video_key,
        order: (section.lectures?.length || 0) + 1,
        is_preview: Boolean(currentForm.is_preview),
      });
      setLectureForms((prev) => ({
        ...prev,
        [section.id]: { title: "", description: "", video_key: "", is_preview: false },
      }));
      await loadCourse();
    } catch (err) {
      setError(apiMessage(err, "Failed to add lecture."));
    }
  };

  const handleDeleteLecture = async (lectureId) => {
    try {
      await deleteLecture(lectureId);
      await loadCourse();
    } catch (err) {
      setError(apiMessage(err, "Failed to delete lecture."));
    }
  };

  if (loading) {
    return <PageShell title="Edit Course">Loading...</PageShell>;
  }

  if (!courseForm) {
    return (
      <PageShell title="Edit Course">
        <p className="text-sm text-red-400">{error || "Unable to load course."}</p>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={`Edit: ${course?.title || "Course"}`}
      subtitle="Manage course details, module structure, and lecture media."
      badge="COURSE OPERATIONS"
    >
      <WorkflowGuidePanel
        title="Editing Workflow"
        subtitle="Use this operational order to keep release quality high."
        steps={[
          {
            title: "Course",
            description: "Keep title/description/pricing in sync with what learners see in catalog.",
          },
          {
            title: "Modules",
            description: "Create logical sections with clear scope before inserting lecture media keys.",
          },
          {
            title: "Govern",
            description: "Delete stale modules/lectures carefully to avoid orphaned playback references.",
          },
        ]}
      />

      <div className="mt-5 grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <div className="rounded-2xl border border-[#2a332d] bg-[#0f1310]/92 p-6 shadow-[0_16px_40px_rgba(0,0,0,0.24)]">
          <CourseForm
            form={courseForm}
            setForm={setCourseForm}
            onSubmit={handleSaveCourse}
            error={error}
            loading={saving}
          />
          {message ? <p className="mt-3 text-sm text-green-400">{message}</p> : null}
        </div>

        <div className="rounded-2xl border border-[#2a332d] bg-[#0f1310]/92 p-6 shadow-[0_16px_40px_rgba(0,0,0,0.24)]">
          <h2 className="text-lg font-semibold">Sections & Lectures</h2>
          <div className="mt-4 space-y-2 rounded-xl border border-[#202820] bg-[#0a0d0a]/90 p-3">
            <FormInput
              label="New Module Title"
              placeholder="Module title"
              value={sectionDraft.title}
              onChange={(e) => setSectionDraft((prev) => ({ ...prev, title: e.target.value }))}
            />
            <FormInput
              label="Module Description"
              as="textarea"
              rows={3}
              placeholder="Describe what this module covers"
              value={sectionDraft.description}
              onChange={(e) =>
                setSectionDraft((prev) => ({ ...prev, description: e.target.value }))
              }
            />
            <Button onClick={handleAddSection}>Add</Button>
          </div>

          <div className="mt-6 space-y-4">
            {(course?.sections || []).map((section) => {
              const lectureForm = lectureForms[section.id] || {
                title: "",
                description: "",
                video_key: "",
                is_preview: false,
              };

              return (
                <div key={section.id} className="rounded-xl border border-[#202820] bg-[#0a0d0a]/90 p-4">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex-1 space-y-2">
                      <FormInput
                        label="Module Title"
                        value={sectionEdits[section.id]?.title ?? section.title}
                        onChange={(e) =>
                          setSectionEdits((prev) => ({
                            ...prev,
                            [section.id]: {
                              title: e.target.value,
                              description:
                                prev[section.id]?.description ?? section.description ?? "",
                            },
                          }))
                        }
                      />
                      <FormInput
                        label="Module Description"
                        as="textarea"
                        rows={3}
                        value={sectionEdits[section.id]?.description ?? section.description ?? ""}
                        onChange={(e) =>
                          setSectionEdits((prev) => ({
                            ...prev,
                            [section.id]: {
                              title: prev[section.id]?.title ?? section.title,
                              description: e.target.value,
                            },
                          }))
                        }
                      />
                      <div>
                        <Button
                          className="px-3 py-1 text-xs"
                          onClick={() => handleSaveSection(section)}
                        >
                          Save Module
                        </Button>
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      className="px-3 py-1 text-xs"
                      onClick={() => handleDeleteSection(section.id)}
                    >
                      Delete Section
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {(section.lectures || []).map((lecture) => (
                      <div
                        key={lecture.id}
                        className="flex items-center justify-between rounded-md border border-[#202820] bg-[#111612] px-3 py-2 text-sm"
                      >
                        <span>{lecture.title}</span>
                        <Button
                          variant="danger"
                          className="px-2 py-1 text-xs"
                          onClick={() => handleDeleteLecture(lecture.id)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 space-y-2 rounded-lg border border-[#202820] bg-[#111612] p-3">
                    <FormInput
                      label="Lecture Title"
                      value={lectureForm.title}
                      onChange={(e) =>
                        setLectureForms((prev) => ({
                          ...prev,
                          [section.id]: { ...lectureForm, title: e.target.value },
                        }))
                      }
                    />
                    <FormInput
                      label="Video S3 Key"
                      value={lectureForm.video_key}
                      onChange={(e) =>
                        setLectureForms((prev) => ({
                          ...prev,
                          [section.id]: { ...lectureForm, video_key: e.target.value },
                        }))
                      }
                    />
                    <FormInput
                      label="Description"
                      as="textarea"
                      rows={2}
                      value={lectureForm.description}
                      onChange={(e) =>
                        setLectureForms((prev) => ({
                          ...prev,
                          [section.id]: { ...lectureForm, description: e.target.value },
                        }))
                      }
                    />
                    <label className="flex items-center gap-2 text-sm text-[#d4dbc8]">
                      <input
                        type="checkbox"
                        checked={lectureForm.is_preview}
                        onChange={(e) =>
                          setLectureForms((prev) => ({
                            ...prev,
                            [section.id]: { ...lectureForm, is_preview: e.target.checked },
                          }))
                        }
                      />
                      Preview lecture
                    </label>
                    <Button onClick={() => handleAddLecture(section)}>Add Lecture</Button>
                  </div>
                </div>
              );
            })}
            {(course?.sections || []).length === 0 && (
              <p className="text-sm text-[#b7c0b0]">Add a section to start adding lectures.</p>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}


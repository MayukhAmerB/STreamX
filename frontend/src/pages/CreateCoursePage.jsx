import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createCourse } from "../api/courses";
import Button from "../components/Button";
import WorkflowGuidePanel from "../components/admin/WorkflowGuidePanel";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { apiData, apiMessage } from "../utils/api";

const initialForm = {
  title: "",
  description: "",
  price: "",
  thumbnail: "",
  thumbnail_file: null,
  is_published: false,
};

export function buildCoursePayload(form) {
  const payload = new FormData();
  payload.append("title", form.title || "");
  payload.append("description", form.description || "");
  payload.append("price", String(form.price ?? ""));
  payload.append("thumbnail", form.thumbnail || "");
  payload.append("is_published", form.is_published ? "true" : "false");
  if (form.thumbnail_file) {
    payload.append("thumbnail_file", form.thumbnail_file);
  }
  return payload;
}

export function CourseForm({ form, setForm, onSubmit, error, loading }) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormInput
        label="Title"
        hint="Use a marketable title with clear outcome and level."
        value={form.title}
        onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
        required
      />
      <FormInput
        label="Description"
        hint="Describe skills learners will gain and what format you follow."
        as="textarea"
        rows={5}
        value={form.description}
        onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput
          label="Price (INR)"
          hint="Use production pricing. Ex: 999, 2499, 4999."
          type="number"
          min="0"
          step="0.01"
          value={form.price}
          onChange={(e) => setForm((p) => ({ ...p, price: e.target.value }))}
          required
        />
        <FormInput
          label="Thumbnail URL"
          hint="Optional public image URL. Leave blank if you upload a local thumbnail file."
          value={form.thumbnail}
          onChange={(e) => setForm((p) => ({ ...p, thumbnail: e.target.value }))}
          placeholder="https://example.com/image.jpg"
        />
      </div>
      <label className="block">
        <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.14em] text-[#aeb8a3]">
          Thumbnail Upload
        </span>
        <input
          key={form.thumbnail_file?.name || "thumbnail-file-empty"}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="w-full rounded-xl border border-[#2a332d] bg-[#0f1310] px-3.5 py-2.5 text-sm text-white file:mr-3 file:rounded-lg file:border-0 file:bg-[#b9c7ab] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-[#0d120f] focus:border-[#b9c7ab] focus:outline-none focus:ring-2 focus:ring-[#b9c7ab]/20"
          onChange={(e) =>
            setForm((p) => ({
              ...p,
              thumbnail_file: e.target.files?.[0] || null,
            }))
          }
        />
        <span className="mt-1.5 block text-xs text-[#8e9987]">
          Hostinger-friendly option. Uploaded files are stored on the app media volume and override the URL above.
        </span>
        {form.thumbnail_file ? (
          <span className="mt-1.5 block text-xs text-[#d4dbc8]">Selected: {form.thumbnail_file.name}</span>
        ) : null}
      </label>
      <label className="flex items-center gap-2 rounded-xl border border-[#2a332d] bg-[#0a0d0a] px-3 py-2 text-sm text-[#d4dbc8]">
        <input
          type="checkbox"
          checked={form.is_published}
          onChange={(e) => setForm((p) => ({ ...p, is_published: e.target.checked }))}
        />
        Publish course
      </label>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <Button type="submit" loading={loading}>
        Save Course
      </Button>
    </form>
  );
}

export default function CreateCoursePage() {
  const navigate = useNavigate();
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await createCourse(buildCoursePayload(form));
      const course = apiData(response);
      navigate(`/instructor/courses/${course.id}/edit`);
    } catch (err) {
      setError(apiMessage(err, "Failed to create course."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageShell
      title="Create Course"
      subtitle="Create a course shell first, then move to module and lecture authoring."
      badge="COURSE AUTHORING"
    >
      <WorkflowGuidePanel
        title="Publishing Workflow"
        subtitle="Follow this to avoid broken learner paths."
        steps={[
          {
            title: "Setup",
            description: "Define title, pricing, and thumbnail with publish off until curriculum is prepared.",
          },
          {
            title: "Author",
            description: "After creating, open edit view and add modules + lectures using uploads or remote media keys.",
          },
          {
            title: "Release",
            description: "Run quality review and then publish when the learner journey is complete.",
          },
        ]}
      />

      <div className="mx-auto mt-5 max-w-4xl rounded-2xl border border-[#2a332d] bg-[#0f1310]/92 p-6 shadow-[0_20px_50px_rgba(0,0,0,0.3)]">
        <CourseForm
          form={form}
          setForm={setForm}
          onSubmit={handleSubmit}
          error={error}
          loading={loading}
        />
      </div>
    </PageShell>
  );
}


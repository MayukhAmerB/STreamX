// Course editor › Overview (T4 form, UI overhaul plan §2.6). OWNER: WS-D2.
// One 640 px column: title, description, price, cover image (drop zone, or a
// link behind a disclosure). Errors inline; the caller owns the action bar.
import { Button, TextArea, TextInput } from "@carbon/react";
import { useState } from "react";
import { DropZone } from "../app-shell/ui";

const IMAGE_TYPES = "image/jpeg,image/png,image/webp";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The catalogue tier a course sits in (hackpath BUILD_PLAN §2.2). Shown only
 * when the API returns one; it is set in the back office, so it is read-only.
 */
export function CatalogTier({ course }) {
  const label = course?.tier_label || "";
  if (!course?.tier || !label) return null;
  const order = Number(course.tier_order);
  return (
    <div className="tch-tier" data-testid="course-tier">
      <span className="tch-label">Catalogue tier</span>
      <p className="tch-tier__value">
        {label}
        {Number.isFinite(order) && order > 0 ? <span className="tch-tier__order"> · position {order}</span> : null}
      </p>
      <p className="tch-muted">Set in the back office under Courses.</p>
    </div>
  );
}

export default function CourseOverviewForm({ form, setForm, errors = {}, readOnly = false, currentThumbnail = "", course = null }) {
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const cover = form.thumbnail_file ? null : form.thumbnail || currentThumbnail;
  const [broken, setBroken] = useState("");
  const showCover = cover && broken !== cover;
  return (
    <div className="tch-form">
      <TextInput
        id="tch-course-title"
        labelText="Title"
        helperText="Plain and specific, e.g. “OSINT Foundations”."
        value={form.title}
        readOnly={readOnly}
        maxCount={200}
        invalid={Boolean(errors.title)}
        invalidText={errors.title}
        onChange={(event) => set({ title: event.target.value })}
      />
      <TextArea
        id="tch-course-description"
        labelText="Description"
        helperText="What students learn and how the course runs."
        rows={5}
        value={form.description}
        readOnly={readOnly}
        invalid={Boolean(errors.description)}
        invalidText={errors.description}
        onChange={(event) => set({ description: event.target.value })}
      />
      <TextInput
        id="tch-course-price"
        labelText="Price (₹)"
        helperText="0 for a free course."
        inputMode="decimal"
        value={form.price}
        readOnly={readOnly}
        invalid={Boolean(errors.price)}
        invalidText={errors.price}
        onChange={(event) => set({ price: event.target.value })}
      />
      <fieldset className="tch-cover">
        <legend className="tch-label">Cover image</legend>
        <div className="tch-cover__body">
          {showCover ? (
            <div className="tch-cover__preview">
              <img src={cover} alt="Current cover" decoding="async" onError={() => setBroken(cover)} />
            </div>
          ) : readOnly ? (
            <p className="tch-muted">No cover yet.</p>
          ) : null}
          {readOnly ? null : form.thumbnail_file ? (
            <p className="tch-video__file">
              {form.thumbnail_file.name}
              <Button kind="ghost" size="sm" onClick={() => set({ thumbnail_file: null })}>
                Remove
              </Button>
            </p>
          ) : (
            <DropZone
              accept={IMAGE_TYPES}
              maxBytes={MAX_IMAGE_BYTES}
              label="Cover image (JPG, PNG or WebP, up to 5 MB, 16:9)"
              onFiles={(files) => files?.[0] && set({ thumbnail_file: files[0] })}
            />
          )}
        </div>
        {readOnly ? null : (
          <details className="tch-disclosure" open={Boolean(form.thumbnail) || undefined}>
            <summary>Use an image link instead</summary>
            <TextInput
              id="tch-course-thumbnail"
              labelText="Image link"
              placeholder="https://"
              value={form.thumbnail}
              invalid={Boolean(errors.thumbnail)}
              invalidText={errors.thumbnail}
              onChange={(event) => set({ thumbnail: event.target.value })}
            />
          </details>
        )}
      </fieldset>
      <CatalogTier course={course} />
    </div>
  );
}

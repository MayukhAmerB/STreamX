// Course authoring model (UI overhaul plan §3.5, Teach › Courses). OWNER: WS-D2.
// Pure helpers: payloads, validation, reordering and the on-device draft
// that keeps unsaved edits when Teaching is switched off mid-edit.

export const EMPTY_COURSE_FORM = Object.freeze({
  title: "",
  description: "",
  price: "",
  thumbnail: "",
  thumbnail_file: null,
  is_published: false,
});

export const EMPTY_LECTURE_FORM = Object.freeze({
  title: "",
  description: "",
  video_key: "",
  video_file: null,
  is_preview: false,
});

function isManagedMediaUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    return new URL(raw).pathname.includes("/media/");
  } catch {
    return raw.includes("/media/");
  }
}

/** Editable fields of a course from the API detail. */
export function courseToForm(course) {
  if (!course) return { ...EMPTY_COURSE_FORM };
  return {
    title: course.title || "",
    description: course.description || "",
    price: course.price === null || course.price === undefined ? "" : String(course.price),
    // An uploaded cover is served from /media/: keep the link field for real links only.
    thumbnail: isManagedMediaUrl(course.thumbnail) ? "" : course.thumbnail || "",
    thumbnail_file: null,
    is_published: Boolean(course.is_published),
  };
}

/** multipart/form-data body for POST /courses/ and PATCH /courses/:id/. */
export function buildCoursePayload(form) {
  const payload = new FormData();
  payload.append("title", form.title || "");
  payload.append("description", form.description || "");
  payload.append("price", String(form.price ?? ""));
  payload.append("thumbnail", form.thumbnail || "");
  payload.append("is_published", form.is_published ? "true" : "false");
  if (form.thumbnail_file) payload.append("thumbnail_file", form.thumbnail_file);
  return payload;
}

/** Field errors before anything is sent ({} when valid). */
export function validateCourseForm(form) {
  const errors = {};
  if (!String(form.title || "").trim()) errors.title = "Give the course a title.";
  if (!String(form.description || "").trim()) errors.description = "Say in a sentence or two what students learn.";
  const price = String(form.price ?? "").trim();
  if (!price) errors.price = "Enter a price in rupees (0 for free).";
  else if (!/^\d+(\.\d{1,2})?$/.test(price)) errors.price = "Use a number like 2499 or 2499.50.";
  const link = String(form.thumbnail || "").trim();
  if (link && !/^https?:\/\//i.test(link)) errors.thumbnail = "Use a full link starting with https://";
  return errors;
}

/** Same fields compared as the user sees them (files never count as saved). */
export function isCourseFormDirty(form, saved) {
  if (!form || !saved) return false;
  if (form.thumbnail_file) return true;
  return ["title", "description", "price", "thumbnail"].some((key) => String(form[key] ?? "") !== String(saved[key] ?? ""));
}

/** multipart body for POST /lectures/. */
export function buildLecturePayload(sectionId, form, order) {
  const payload = new FormData();
  payload.append("section", String(sectionId));
  payload.append("title", String(form.title || "").trim());
  payload.append("description", String(form.description || "").trim());
  payload.append("video_key", String(form.video_key || "").trim());
  payload.append("order", String(order));
  payload.append("is_preview", form.is_preview ? "true" : "false");
  if (form.video_file) payload.append("video_file", form.video_file);
  return payload;
}

export function validateLectureForm(form) {
  const errors = {};
  if (!String(form.title || "").trim()) errors.title = "Give the lecture a title.";
  if (!form.video_file && !String(form.video_key || "").trim()) errors.video = "Add a video file, or the storage key or link of one.";
  return errors;
}

/** JSON body for PUT /lectures/:id/ (keeps the video; changes order or preview). */
export function lectureUpdatePayload(sectionId, lecture, changes = {}) {
  return {
    section: sectionId,
    title: lecture.title,
    description: lecture.description || "",
    order: lecture.order,
    is_preview: Boolean(lecture.is_preview),
    ...changes,
  };
}

/** JSON body for PUT /sections/:id/. */
export function sectionUpdatePayload(courseId, section, changes = {}) {
  return {
    course: Number(courseId),
    title: section.title,
    description: section.description || "",
    order: section.order,
    ...changes,
  };
}

/** A copy of `items` with the item at `from` moved to `to` (clamped). */
export function moveItem(items, from, to) {
  const list = [...(items || [])];
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return list;
  const [item] = list.splice(from, 1);
  list.splice(target, 0, item);
  return list;
}

/** Renumbers 1..n; returns { items, changed: [{ id, order }] } for rows whose order moved. */
export function renumber(items) {
  const changed = [];
  const next = (items || []).map((item, index) => {
    const order = index + 1;
    if (item.order !== order) changed.push({ id: item.id, order });
    return item.order === order ? item : { ...item, order };
  });
  return { items: next, changed };
}

/**
 * Keyboard reordering on a focused row: Alt+↑ / Alt+↓ move by one,
 * Alt+Home / Alt+End to the ends. Returns the new index or null.
 */
export function reorderKeyTarget(event, index, length) {
  if (!event?.altKey || event.ctrlKey || event.metaKey) return null;
  let target = null;
  if (event.key === "ArrowUp") target = index - 1;
  else if (event.key === "ArrowDown") target = index + 1;
  else if (event.key === "Home") target = 0;
  else if (event.key === "End") target = length - 1;
  if (target === null || target < 0 || target >= length || target === index) return null;
  return target;
}

export function curriculumCounts(course) {
  const sections = course?.sections || [];
  const lectures = sections.reduce((sum, section) => sum + (section.lectures?.length || 0), 0);
  return { modules: sections.length, lectures };
}

/** "3 modules · 12 lectures" */
export function describeCurriculum(counts) {
  const modules = counts?.modules || 0;
  const lectures = counts?.lectures || 0;
  return `${modules} ${modules === 1 ? "module" : "modules"} · ${lectures} ${lectures === 1 ? "lecture" : "lectures"}`;
}

/** Why the course cannot be published yet ("" when it can). */
export function publishBlocker(course) {
  if (!course) return "Save the course first.";
  if (!curriculumCounts(course).lectures) return "Add at least one lecture before publishing.";
  return "";
}

// --- On-device draft (sessionStorage, wrapped: storage can be blocked) -----------
const DRAFT_PREFIX = "teach-course-draft:";

export function draftKey(courseId) {
  return `${DRAFT_PREFIX}${courseId || "new"}`;
}

function storage() {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Saves the text fields of a course form (files cannot be kept). */
export function saveCourseDraft(courseId, form) {
  const store = storage();
  if (!store || !form) return false;
  try {
    const { title, description, price, thumbnail } = form;
    store.setItem(draftKey(courseId), JSON.stringify({ title, description, price, thumbnail, saved_at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function loadCourseDraft(courseId) {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(draftKey(courseId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return {
      title: String(data.title ?? ""),
      description: String(data.description ?? ""),
      price: String(data.price ?? ""),
      thumbnail: String(data.thumbnail ?? ""),
      saved_at: Number(data.saved_at) || null,
    };
  } catch {
    return null;
  }
}

export function clearCourseDraft(courseId) {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(draftKey(courseId));
  } catch {
    // Storage blocked: nothing was kept anyway.
  }
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLectureQuestion,
  getLectureNote,
  getLectureQuestions,
  updateLectureNote,
} from "../../api/courses";
import { apiData, apiMessage } from "../../utils/api";
import { formatDateTime } from "./formatters";

export const NOTE_MAX_LENGTH = 20000;
export const QUESTION_MAX_LENGTH = 3000;

/** Private per-lecture notes (load + explicit save), as on the old page. */
export function useLectureNotes(lectureId, { enabled = true } = {}) {
  const activeId = enabled && lectureId ? lectureId : null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [state, setState] = useState({ loading: false, saving: false, error: "", savedAt: "" });

  useEffect(() => {
    setDraft("");
    setSavedContent("");
    if (!activeId) {
      setState({ loading: false, saving: false, error: "", savedAt: "" });
      return undefined;
    }
    let cancelled = false;
    setState({ loading: true, saving: false, error: "", savedAt: "" });
    getLectureNote(activeId)
      .then((response) => {
        if (cancelled) return;
        const note = apiData(response) || {};
        setDraft(note.content || "");
        setSavedContent(note.content || "");
        setState({ loading: false, saving: false, error: "", savedAt: note.updated_at ? formatDateTime(note.updated_at) : "" });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ loading: false, saving: false, error: apiMessage(error, "Unable to load your lecture notes."), savedAt: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const updateDraft = useCallback((value) => {
    setDraft(value);
    setState((current) => (current.error ? { ...current, error: "" } : current));
  }, []);

  const save = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return false;
    setState((current) => ({ ...current, saving: true, error: "" }));
    try {
      const note = apiData(await updateLectureNote(id, { content: draft })) || {};
      if (activeIdRef.current !== id) return false;
      setDraft(note.content ?? draft);
      setSavedContent(note.content ?? draft);
      setState({ loading: false, saving: false, error: "", savedAt: note.updated_at ? formatDateTime(note.updated_at) : "just now" });
      return true;
    } catch (error) {
      if (activeIdRef.current !== id) return false;
      setState((current) => ({ ...current, saving: false, error: apiMessage(error, "Unable to save your lecture notes.") }));
      return false;
    }
  }, [draft]);

  return { draft, setDraft: updateDraft, save, dirty: draft !== savedContent, ...state };
}

/** Private questions to the instructor (answered every Friday), as on the old page. */
export function useLectureQuestions(lectureId, { enabled = true } = {}) {
  const activeId = enabled && lectureId ? lectureId : null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const [draft, setDraft] = useState("");
  const [questions, setQuestions] = useState([]);
  const [state, setState] = useState({ loading: false, submitting: false, error: "", success: "" });

  useEffect(() => {
    setDraft("");
    setQuestions([]);
    if (!activeId) {
      setState({ loading: false, submitting: false, error: "", success: "" });
      return undefined;
    }
    let cancelled = false;
    setState({ loading: true, submitting: false, error: "", success: "" });
    getLectureQuestions(activeId)
      .then((response) => {
        if (cancelled) return;
        setQuestions(apiData(response) || []);
        setState({ loading: false, submitting: false, error: "", success: "" });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ loading: false, submitting: false, error: apiMessage(error, "Unable to load your lecture questions."), success: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const updateDraft = useCallback((value) => {
    setDraft(value);
    setState((current) => (current.error || current.success ? { ...current, error: "", success: "" } : current));
  }, []);

  const submit = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return false;
    const question = draft.trim();
    if (!question) {
      setState((current) => ({ ...current, error: "Type your question before submitting.", success: "" }));
      return false;
    }
    setState((current) => ({ ...current, submitting: true, error: "", success: "" }));
    try {
      const created = apiData(await createLectureQuestion(id, { question }));
      if (activeIdRef.current !== id) return false;
      setQuestions((current) => (created ? [created, ...current] : current));
      setDraft("");
      setState({ loading: false, submitting: false, error: "", success: "Question sent. Questions are answered every Friday." });
      return true;
    } catch (error) {
      if (activeIdRef.current !== id) return false;
      setState((current) => ({ ...current, submitting: false, error: apiMessage(error, "Unable to submit your question."), success: "" }));
      return false;
    }
  }, [draft]);

  return { draft, setDraft: updateDraft, submit, questions, ...state };
}

import { Locked } from "@carbon/icons-react";
import { Button, InlineLoading, SkeletonText, Tag, TextArea } from "@carbon/react";
import { forwardRef } from "react";
import PageNotification from "../app-shell/ui/PageNotification";
import { formatRelativeTime } from "./formatters";
import { NOTE_MAX_LENGTH, QUESTION_MAX_LENGTH } from "./useLectureStudyTools";

function LockedMessage({ text }) {
  return (
    <div className="cp-panel-message">
      <Locked size={24} aria-hidden="true" />
      <p className="cp-panel-message__title">{text}</p>
    </div>
  );
}

/** Private notes for this lesson (saved to the learner's account). */
export const NotesPanel = forwardRef(function NotesPanel({ notes, locked }, headingRef) {
  return (
    <div className="cp-study">
      <h2 ref={headingRef} id="cp-panel-heading-notes" className="cp-panel-title" tabIndex={-1}>
        My notes
      </h2>
      {locked ? (
        <LockedMessage text="Enroll to take notes on this lesson." />
      ) : notes.loading ? (
        <div role="status" aria-busy="true">
          <span className="cds--visually-hidden">Loading your notes</span>
          <SkeletonText paragraph lineCount={4} />
        </div>
      ) : (
        <form
          className="cp-study__form"
          onSubmit={(event) => {
            event.preventDefault();
            void notes.save();
          }}
        >
          <TextArea
            id="cp-notes-input"
            labelText="Notes for this lesson"
            helperText="Only you can see these notes."
            placeholder="Key commands, timestamps, takeaways…"
            rows={8}
            maxLength={NOTE_MAX_LENGTH}
            value={notes.draft}
            onChange={(event) => notes.setDraft(event.target.value)}
            invalid={Boolean(notes.error)}
            invalidText={notes.error}
          />
          <div className="cp-study__footer">
            <span className="cp-study__status" aria-live="polite">
              {notes.saving ? null : notes.dirty ? "Unsaved changes" : notes.savedAt ? `Saved ${notes.savedAt}` : ""}
            </span>
            {notes.saving ? (
              <InlineLoading description="Saving…" className="cp-study__saving" />
            ) : (
              <Button type="submit" kind="primary" size="md" disabled={!notes.dirty}>
                Save notes
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
});

const QUESTION_STATUS_TAG = {
  answered: "green",
  reviewed: "blue",
};

/** Private questions to the instructor, answered every Friday. */
export const QuestionsPanel = forwardRef(function QuestionsPanel({ questions, locked, now }, headingRef) {
  return (
    <div className="cp-study">
      <h2 ref={headingRef} id="cp-panel-heading-questions" className="cp-panel-title" tabIndex={-1}>
        Ask the instructor
      </h2>
      {locked ? (
        <LockedMessage text="Enroll to ask questions about this lesson." />
      ) : (
        <>
          <p className="cp-muted cp-study__intro">
            Only the teaching team sees these. Questions are answered every Friday.
          </p>
          <form
            className="cp-study__form"
            onSubmit={(event) => {
              event.preventDefault();
              void questions.submit();
            }}
          >
            <TextArea
              id="cp-question-input"
              labelText="Your question"
              placeholder="What would you like to ask about this lesson?"
              rows={4}
              maxLength={QUESTION_MAX_LENGTH}
              value={questions.draft}
              onChange={(event) => questions.setDraft(event.target.value)}
              invalid={Boolean(questions.error)}
              invalidText={questions.error}
            />
            <div className="cp-study__footer">
              <span className="cp-study__status" />
              {questions.submitting ? (
                <InlineLoading description="Sending…" className="cp-study__saving" />
              ) : (
                <Button type="submit" kind="primary" size="md" disabled={!questions.draft.trim()}>
                  Send question
                </Button>
              )}
            </div>
          </form>
          {questions.success ? <PageNotification kind="success" title={questions.success} /> : null}

          <h3 className="cp-section-title">Your questions</h3>
          {questions.loading ? (
            <div role="status" aria-busy="true">
              <span className="cds--visually-hidden">Loading your questions</span>
              <SkeletonText paragraph lineCount={3} />
            </div>
          ) : questions.questions.length ? (
            <ul className="cp-questions">
              {questions.questions.map((question) => (
                <li key={question.id} className="cp-question">
                  <div className="cp-question__meta">
                    <Tag type={QUESTION_STATUS_TAG[question.status] || "gray"} size="sm">
                      {question.status_label || question.status || "Pending"}
                    </Tag>
                    {question.created_at ? (
                      <time dateTime={question.created_at} className="cp-question__time">
                        {formatRelativeTime(question.created_at, now)}
                      </time>
                    ) : null}
                  </div>
                  <p className="cp-question__text">{question.question}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="cp-muted">You haven&apos;t asked anything about this lesson yet.</p>
          )}
        </>
      )}
    </div>
  );
});

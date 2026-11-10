import { Button, Tag } from "@carbon/react";
import { useState } from "react";
import CommentComposer, { Avatar } from "./CommentComposer";
import { formatFullDate, formatRelativeTime } from "./formatters";

/**
 * A comment: initials avatar, name, "Instructor" tag, "2h ago", "Edited",
 * body, and Edit / Delete as plain inline buttons (no floating menu).
 */
export default function CommentItem({ comment, onEdit, onDelete, now }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const author = comment.author || {};
  const name = author.display_name || "Learner";
  const pending = Boolean(comment.pending) || String(comment.id).startsWith("temp-");
  const canEdit = Boolean(comment.is_mine) && !pending && typeof onEdit === "function";
  const canDelete = Boolean(comment.can_delete) && !pending && typeof onDelete === "function";

  return (
    <li className={`cp-comment${pending ? " is-pending" : ""}`}>
      <Avatar name={name} seed={author.id ?? name} />
      <div className="cp-comment__main">
        <p className="cp-comment__meta">
          <span className="cp-comment__author">{name}</span>
          {author.is_instructor ? (
            <Tag type="blue" size="sm" className="cp-comment__tag">
              Instructor
            </Tag>
          ) : null}
          {pending ? (
            <span className="cp-comment__time">Posting…</span>
          ) : (
            <time className="cp-comment__time" dateTime={comment.created_at} title={formatFullDate(comment.created_at)}>
              {formatRelativeTime(comment.created_at, now)}
            </time>
          )}
          {comment.is_edited ? <span className="cp-comment__edited">Edited</span> : null}
        </p>

        {editing ? (
          <CommentComposer
            variant="edit"
            initialValue={comment.body}
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              setEditing(false);
              return onEdit(comment.id, body);
            }}
          />
        ) : (
          <p className="cp-comment__body">{comment.body}</p>
        )}

        {!editing && confirmingDelete ? (
          <div className="cp-comment__confirm" role="group" aria-label="Delete this comment?">
            <span className="cp-comment__confirm-text">Delete this comment?</span>
            <Button kind="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              kind="danger--ghost"
              size="sm"
              onClick={() => {
                setConfirmingDelete(false);
                void onDelete(comment.id);
              }}
            >
              Delete
            </Button>
          </div>
        ) : null}

        {!editing && !confirmingDelete && (canEdit || canDelete) ? (
          <div className="cp-comment__actions">
            {canEdit ? (
              <Button kind="ghost" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button kind="ghost" size="sm" onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import apiClient from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";

export default function CourseReviews({ courseId, experience, refresh }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const [writing, setWriting] = useState(false);
  const [rating, setRating] = useState(experience.own_review?.rating || 5);
  const [text, setText] = useState(experience.own_review?.text || "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState([]);
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(experience.has_more);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await apiClient.post(`/courses/${courseId}/reviews/`, {
        rating: Number(rating),
        text,
      });
      setWriting(false);
      setMessage("Thank you. Your review is now published.");
      await refresh();
    } catch (err) {
      setMessage(apiMessage(err, "Your review could not be submitted."));
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async () => {
    setBusy(true);
    try {
      const data = apiData(
        await apiClient.get(`/courses/${courseId}/experience/`, {
          params: { page: page + 1 },
        })
      );
      setExtra((items) => [...items, ...data.reviews]);
      setMore(data.has_more);
      setPage(page + 1);
    } catch (err) {
      setMessage(apiMessage(err, "Reviews could not be loaded."));
    } finally {
      setBusy(false);
    }
  };

  const own = experience.own_review;
  const reviews = [...experience.reviews, ...extra];

  return (
    <section className="panel course-reviews-panel" id="reviews" tabIndex={-1}>
      <div className="detail-section-heading">
        <span className="detail-section-number" aria-hidden="true">
          05
        </span>
        <div>
          <div className="eyebrow">Student perspectives</div>
          <h2>Verified course reviews</h2>
          <p className="detail-section-description">
            Verified reviews are shared across every batch in this training track and published instantly. Administrators can remove inappropriate reviews.
          </p>
        </div>
      </div>

      <div className="detail-review-summary">
        <strong>
          {experience.average_rating === null ? "New" : experience.average_rating}
        </strong>
        <div>
          <span>{experience.average_rating === null ? "No rating yet" : "out of 5"}</span>
          <small>
            {experience.review_count} verified review{experience.review_count === 1 ? "" : "s"}
          </small>
        </div>
      </div>

      {!isAuthenticated ? (
        <Link
          className="action secondary full"
          to="/login"
          state={{ from: `${location.pathname}#reviews` }}
        >
          Sign in to write a review
        </Link>
      ) : !experience.can_review ? (
        <p className="message">Reviewing is available to confirmed students of this course.</p>
      ) : own && !own.edit_allowed ? (
        <p className="message">
          {own.status === "approved"
            ? "Your review is published. Contact support to request an edit."
            : "Your review is not currently public. Contact support if you need help."}
        </p>
      ) : (
        <button className="action secondary full" onClick={() => setWriting(!writing)}>
          {own ? "Edit your review" : "Write a review"}
        </button>
      )}

      {writing ? (
        <form onSubmit={submit} className="detail-review-form">
          <label>
            Rating
            <select value={rating} onChange={(event) => setRating(event.target.value)}>
              {[5, 4, 3, 2, 1].map((value) => (
                <option key={value} value={value}>
                  {value} out of 5
                </option>
              ))}
            </select>
          </label>
          <label>
            Your review
            <textarea
              required
              minLength={10}
              maxLength={3000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <p className="muted">
            Published as "Verified student". Avoid personal contact information in your review.
          </p>
          <button className="action" disabled={busy}>
            {busy ? "Publishing..." : "Publish review"}
          </button>
        </form>
      ) : null}

      {message ? (
        <p className="message" role="status">
          {message}
        </p>
      ) : null}

      <div className="detail-review-list">
        {reviews.map((review, index) => (
          <article className="review" key={`${review.date}-${index}`}>
            <div className="review-meta">
              <span aria-label={`${review.rating} out of 5 stars`}>
                {review.rating} / 5
              </span>
              <span>{review.author}</span>
              <span className="detail-verified-label">Verified</span>
              <time dateTime={review.date}>{new Date(review.date).toLocaleDateString()}</time>
            </div>
            <p style={{ whiteSpace: "pre-wrap" }}>{review.text}</p>
          </article>
        ))}
      </div>

      {more ? (
        <button className="action secondary" onClick={loadMore} disabled={busy}>
          Load more reviews
        </button>
      ) : null}
    </section>
  );
}

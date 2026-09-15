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
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      await apiClient.post(`/courses/${courseId}/reviews/`, { rating: Number(rating), text });
      setWriting(false); setMessage("Thank you. Your review is pending moderation."); await refresh();
    } catch (err) { setMessage(apiMessage(err, "Your review could not be submitted.")); }
    finally { setBusy(false); }
  };
  const loadMore = async () => {
    setBusy(true);
    try {
      const data = apiData(await apiClient.get(`/courses/${courseId}/experience/`, { params: { page: page + 1 } }));
      setExtra((items) => [...items, ...data.reviews]); setMore(data.has_more); setPage(page + 1);
    } catch (err) { setMessage(apiMessage(err, "Reviews could not be loaded.")); }
    finally { setBusy(false); }
  };
  const own = experience.own_review;
  return <section className="panel" id="reviews"><div className="eyebrow">Student perspectives</div><h2>Reviews</h2>
    <p>{experience.average_rating === null ? "No approved reviews yet" : `${experience.average_rating} / 5 stars`} <span className="muted"> · {experience.review_count} reviews</span></p>
    <p className="muted">Reviews come from confirmed students and are moderated before publication.</p>
    {!isAuthenticated ? <Link className="action secondary full" to="/login" state={{ from: location.pathname + "#reviews" }}>Sign in to write a review</Link>
      : !experience.can_review ? <p className="message">Reviewing is available to confirmed students of this course.</p>
        : own && !own.edit_allowed ? <p className="message">Your review is {own.status}. Contact support to request an edit.</p>
          : <button className="action secondary full" onClick={() => setWriting(!writing)}>{own ? "Edit your review" : "Write a review"}</button>}
    {writing && <form onSubmit={submit} style={{ marginTop: 24 }}>
      <label>Rating<select value={rating} onChange={(event) => setRating(event.target.value)}>{[5, 4, 3, 2, 1].map((value) => <option key={value} value={value}>{"★".repeat(value)} — {value} out of 5</option>)}</select></label>
      <label>Your review<textarea required minLength={10} maxLength={3000} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <p className="muted">Published as “Verified student”. Avoid personal contact information in your review.</p>
      <button className="action" disabled={busy}>{busy ? "Submitting…" : "Submit for moderation"}</button>
    </form>}
    {message && <p className="message" role="status">{message}</p>}
    {[...experience.reviews, ...extra].map((review, index) => <article className="review" key={`${review.date}-${index}`}>
      <div className="review-meta"><span aria-label={`${review.rating} out of 5 stars`}>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</span><span>{review.author} ✓</span><time dateTime={review.date}>{new Date(review.date).toLocaleDateString()}</time></div>
      <p style={{ whiteSpace: "pre-wrap" }}>{review.text}</p>
    </article>)}
    {more && <button className="action secondary" onClick={loadMore} disabled={busy}>Load more reviews</button>}
  </section>;
}

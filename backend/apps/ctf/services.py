"""Business rules for CTF exams: starting, recording answers, finishing.

Recording an answer (``submit_attempt``) runs in ONE transaction:

1. lock the student's participation row (``select_for_update``);
2. refuse if the exam is over for them (submitted, deadline passed, closed);
3. refuse if the question is already solved, or its attempts are used up;
4. evaluate the answer and insert the attempt (``attempt_number = used + 1``);
5. add the points (first correct answer only) and bump the counters.

Refusals in steps 2-3 are not evaluated answers, so they are not stored as
attempts (the view writes them to the security log). The partial unique
constraint ``ctf_attempt_one_correct`` is the final guarantee that a
question scores once even if two requests race past the lock.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from django.db import IntegrityError, transaction
from django.db.models import Count, Q, Sum
from django.utils import timezone
from django.utils.crypto import salted_hmac

from apps.core.errors import Conflict, NotFound

from . import access, answers
from .models import MAX_ANSWER_LENGTH, CtfAttempt, CtfExam, CtfParticipation, CtfQuestion

logger = logging.getLogger("apps.ctf")


@dataclass(frozen=True)
class AttemptOutcome:
    attempt: CtfAttempt
    participation: CtfParticipation
    attempts_remaining: int


def active_questions(exam):
    return CtfQuestion.objects.filter(exam=exam, is_active=True).order_by("order", "id")


def hash_client_ip(ip):
    ip = str(ip or "").strip()
    if not ip:
        return ""
    return salted_hmac("apps.ctf.ip", ip, algorithm="sha256").hexdigest()


def _require_current_answer_key(exam):
    """Refuse to start or evaluate while the stored hashes were made with a
    different pepper: every answer would be marked wrong and burn attempts."""
    if exam.answer_key_id != answers.answer_key_id():
        logger.error("ctf exam %s: answer key does not match CTF_ANSWER_PEPPER; reload the exam file", exam.slug)
        raise answers.CtfNotConfigured(
            "This exam's answer key is being updated. Please try again shortly.", code="ctf_answer_key_mismatch"
        )


def expire_if_due(participation, at=None):
    """Mark an active participation whose deadline passed as expired (read paths)."""
    if participation is None or participation.status != CtfParticipation.STATUS_ACTIVE:
        return participation
    at = at or timezone.now()
    if participation.deadline_passed(at):
        CtfParticipation.objects.filter(pk=participation.pk, status=CtfParticipation.STATUS_ACTIVE).update(
            status=CtfParticipation.STATUS_EXPIRED, updated_at=at
        )
        participation.status = CtfParticipation.STATUS_EXPIRED
    return participation


def start_participation(*, exam, user, at=None):
    """Return ``(participation, created)``. Starting twice returns the first one."""
    now = at or timezone.now()
    existing = CtfParticipation.objects.filter(exam=exam, user=user).first()
    if existing is not None:
        return expire_if_due(existing, now), False

    is_staff = access.is_staff_user(user)
    if not is_staff:
        window = exam.window(now)
        if window == CtfExam.WINDOW_NOT_OPEN:
            raise Conflict("This exam has not opened yet.", code="ctf_exam_not_open")
        if window == CtfExam.WINDOW_CLOSED:
            raise Conflict("This exam has closed.", code="ctf_exam_closed")
    if not active_questions(exam).exists():
        raise Conflict("This exam has no questions yet.", code="ctf_exam_not_ready")
    _require_current_answer_key(exam)

    participation = CtfParticipation(
        exam=exam,
        user=user,
        batch_course=access.batch_course_for(user, exam),
        is_staff_preview=is_staff,
        started_at=now,
        deadline_at=exam.deadline_for(now, ignore_closes_at=is_staff),
    )
    try:
        with transaction.atomic():
            participation.save()
    except IntegrityError:
        # A parallel Start won the race: return that one.
        return CtfParticipation.objects.get(exam=exam, user=user), False
    return participation, True


def _refusal_for(participation, exam, now):
    """Return the Conflict to raise (after commit) when the exam is over for this
    participation, marking it expired when its time ran out."""
    if participation.status == CtfParticipation.STATUS_SUBMITTED:
        return Conflict("You have already submitted this exam.", code="ctf_participation_submitted")
    student = not participation.is_staff_preview
    # The exam's own closing time is checked too, so an admin who moves
    # closes_at after students started still ends everyone's exam on time.
    exam_closed = student and exam.status != CtfExam.STATUS_PUBLISHED
    window_over = student and bool(exam.closes_at and now >= exam.closes_at)
    if (
        participation.status == CtfParticipation.STATUS_EXPIRED
        or participation.deadline_passed(now)
        or exam_closed
        or window_over
    ):
        if participation.status == CtfParticipation.STATUS_ACTIVE:
            participation.status = CtfParticipation.STATUS_EXPIRED
            participation.save(update_fields=["status", "updated_at"])
        if exam_closed:
            return Conflict("This exam has closed.", code="ctf_exam_closed")
        return Conflict("Your time for this exam is over.", code="ctf_exam_time_over")
    return None


def submit_attempt(*, exam, user, question_key, answer, client_ip="", user_agent="", at=None):
    """Evaluate and record one answer. Returns an ``AttemptOutcome``."""
    question = active_questions(exam).filter(key=str(question_key or "")[:64]).first()
    if question is None:
        raise NotFound("Question not found.", code="ctf_question_not_found")
    _require_current_answer_key(exam)
    submitted = str(answer or "")[:MAX_ANSWER_LENGTH]

    refusal = None
    outcome = None
    with transaction.atomic():
        participation = CtfParticipation.objects.select_for_update().filter(exam=exam, user=user).first()
        if participation is None:
            refusal = Conflict("Start the exam before answering.", code="ctf_not_started")
        else:
            now = at or timezone.now()
            refusal = _refusal_for(participation, exam, now)
            if refusal is None:
                stats = CtfAttempt.objects.filter(participation=participation, question=question).aggregate(
                    used=Count("id"), solved=Count("id", filter=Q(is_correct=True))
                )
                used = int(stats["used"] or 0)
                limit = question.effective_max_attempts(exam)
                if stats["solved"]:
                    refusal = Conflict("You have already solved this question.", code="ctf_question_already_solved")
                elif used >= limit:
                    refusal = Conflict("You have used every attempt for this question.", code="ctf_attempts_exhausted")
                else:
                    correct, normalized = answers.verify(
                        exam.slug, question.key, submitted, question.normalization, question.answer_hashes
                    )
                    points = int(question.points) if correct else 0
                    try:
                        with transaction.atomic():
                            attempt = CtfAttempt.objects.create(
                                participation=participation,
                                exam=exam,
                                user=user,
                                question=question,
                                attempt_number=used + 1,
                                submitted_answer=submitted,
                                normalized_answer=normalized[:MAX_ANSWER_LENGTH],
                                is_correct=correct,
                                points_awarded=points,
                                client_ip_hash=hash_client_ip(client_ip),
                                user_agent=str(user_agent or "")[:256],
                                created_at=now,
                            )
                    except IntegrityError:
                        refusal = Conflict(
                            "Another answer to this question was recorded at the same moment. Refresh and try again.",
                            code="ctf_attempt_conflict",
                        )
                    else:
                        participation.attempt_count += 1
                        if correct:
                            participation.score += points
                            participation.solved_count += 1
                            participation.last_correct_at = now
                        else:
                            participation.wrong_count += 1
                        participation.save(
                            update_fields=[
                                "attempt_count",
                                "score",
                                "solved_count",
                                "wrong_count",
                                "last_correct_at",
                                "updated_at",
                            ]
                        )
                        remaining = 0 if correct else max(0, limit - (used + 1))
                        outcome = AttemptOutcome(attempt, participation, remaining)
    if refusal is not None:
        raise refusal
    return outcome


def finish_participation(*, exam, user, at=None):
    """End the exam early. Finishing an exam that is already over is a no-op."""
    now = at or timezone.now()
    with transaction.atomic():
        participation = CtfParticipation.objects.select_for_update().filter(exam=exam, user=user).first()
        if participation is None:
            raise Conflict("Start the exam before submitting it.", code="ctf_not_started")
        if participation.status == CtfParticipation.STATUS_ACTIVE:
            if participation.deadline_passed(now):
                participation.status = CtfParticipation.STATUS_EXPIRED
            else:
                participation.status = CtfParticipation.STATUS_SUBMITTED
                participation.submitted_at = now
            participation.save(update_fields=["status", "submitted_at", "updated_at"])
    return participation


def question_progress(participation):
    """``{question_id: {"used", "solved", "points"}}`` for one participation."""
    if participation is None:
        return {}
    rows = (
        CtfAttempt.objects.filter(participation=participation)
        .values("question_id")
        .annotate(
            used=Count("id"),
            solved=Count("id", filter=Q(is_correct=True)),
            points=Sum("points_awarded"),
        )
    )
    return {
        row["question_id"]: {"used": int(row["used"] or 0), "solved": bool(row["solved"]), "points": int(row["points"] or 0)}
        for row in rows
    }

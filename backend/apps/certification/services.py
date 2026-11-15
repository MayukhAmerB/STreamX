"""Automatic certification.

Flow (no manual step)::

    student finishes / time runs out / exam window closes
      -> signals.participation_saved  or  sweep (periodic safety net)
      -> outbox "certification.decide"  -> decide_participation()
           one CertificationDecision per (exam, student)   [unique, idempotent]
           PASS -> issue the Certificate (engagement, real name, reference)
                -> Hall of Fame entry (handle only, opt-out respected)
                -> CertificateDelivery rows (e-mail / WhatsApp) + outbox events
      -> outbox "certification.deliver" -> delivery.deliver()  (retries with backoff)

Re-grade (``regrade_exam``) re-checks every recorded answer against the
current answer key. fail -> pass issues the certificate at once; pass -> fail
only FLAGS the decision (``revocation_pending``) until staff confirm
(``confirm_revocation``) or dismiss it. Every step leaves a
``CertificationAudit`` row.
"""

from __future__ import annotations

import logging

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.core.errors import Conflict, ValidationFailed
from apps.core.outbox import publish
from apps.engagement import certificates
from apps.engagement.models import Certificate

from . import grading, whatsapp
from .models import (
    CertificateDelivery,
    CertificationAudit,
    CertificationDecision,
    CertificationPreferences,
    ExamCertificationPolicy,
    HallOfFameEntry,
)

logger = logging.getLogger("apps.certification")

EVENT_DECIDE = "certification.decide"
EVENT_DELIVER = "certification.deliver"
DEFAULT_ACHIEVEMENT = "Certified OSINT Investigator"
ALLOWED_CERT_TYPES = {"OSINT", "PEN", "COURSE", "EXAM"}


# --- lookups ---------------------------------------------------------------------------------------------
def active_policy(exam_id) -> ExamCertificationPolicy | None:
    return ExamCertificationPolicy.objects.filter(exam_id=exam_id, is_enabled=True).first()


def preferences_for(user) -> CertificationPreferences:
    """The student's saved preferences, or the defaults (not saved)."""
    prefs = CertificationPreferences.objects.filter(user_id=getattr(user, "pk", user)).first()
    return prefs or CertificationPreferences(user_id=getattr(user, "pk", user))


def participation_ended(participation, now=None) -> bool:
    from apps.ctf.models import CtfExam, CtfParticipation

    now = now or timezone.now()
    if participation.status in (CtfParticipation.STATUS_SUBMITTED, CtfParticipation.STATUS_EXPIRED):
        return True
    exam = participation.exam
    return bool(
        participation.deadline_passed(now)
        or exam.status == CtfExam.STATUS_CLOSED
        or (exam.closes_at and now >= exam.closes_at)
    )


def _actor_fields(actor) -> dict:
    return {
        "actor": actor if getattr(actor, "pk", None) else None,
        "actor_email": str(getattr(actor, "email", "") or "")[:254],
    }


def _audit(decision, action, *, before=None, after=None, actor=None, reason="", detail=None):
    CertificationAudit.objects.create(
        decision=decision,
        action=action,
        outcome_before=(before or {}).get("outcome", ""),
        outcome_after=(after or {}).get("outcome", ""),
        percent_before=(before or {}).get("percent"),
        percent_after=(after or {}).get("percent"),
        detail=detail or {},
        reason=str(reason or "")[:300],
        **_actor_fields(actor),
    )


def _snapshot(decision) -> dict:
    return {"outcome": decision.outcome, "percent": decision.percent}


# --- certificate -----------------------------------------------------------------------------------------
def batch_label_for(participation) -> str:
    course = getattr(participation, "batch_course", None)
    if course is None:
        return ""
    batch = str(getattr(course, "batch", "") or "").strip()
    if batch:
        return batch if batch.lower().startswith("batch") else f"Batch {batch}"
    return ""


def certificate_facts(policy, exam, participation) -> dict:
    cert_type = policy.certificate_type if policy.certificate_type in ALLOWED_CERT_TYPES else Certificate.TYPE_OSINT
    label = certificates.TYPE_LABELS.get(cert_type, "Professional")
    programme = f"{label} certification"
    batch = batch_label_for(participation)
    if batch:
        programme += f" · {batch}"
    return {
        "cert_type": cert_type,
        "heading": "Certificate of Certification",
        "statement": "has passed the certification examination",
        "title": (policy.certificate_title or exam.title or "Certification Examination")[:200],
        "programme": programme[:220],
    }


def _holder_name(user, participation) -> str:
    name = certificates.real_name(user)
    if not name:
        name = certificates.clean_name(getattr(participation, "student_name_snapshot", "") or "")
    return name


def _issue_certificate(decision, participation, policy, *, actor=None) -> Certificate:
    """Issue (or reinstate) the decision's certificate. Runs inside the decision transaction."""
    if decision.certificate_id:
        certificate = Certificate.objects.select_for_update().get(pk=decision.certificate_id)
        if certificate.revoked_at is not None:
            certificate = certificates.reinstate(
                certificate, actor=actor, reason="Re-grade: the student passes the certification exam again."
            )
            _audit(decision, CertificationAudit.ACTION_CERTIFICATE_REINSTATED, actor=actor,
                   detail={"reference": certificate.reference})
        return certificate
    facts = certificate_facts(policy, participation.exam, participation)
    name = _holder_name(participation.user, participation)
    certificate = certificates._create(  # noqa: SLF001 - the engagement issuing primitive (reference + audit)
        user_id=decision.user_id, issued_at=timezone.now(), name=name, facts=facts, link={}
    )
    decision.certificate = certificate
    decision.save(update_fields=["certificate", "updated_at"])
    _audit(decision, CertificationAudit.ACTION_CERTIFICATE_ISSUED, actor=actor, detail={"reference": certificate.reference})
    return certificate


def _add_to_hall_of_fame(decision, participation, policy):
    from . import hall_of_fame

    try:
        with transaction.atomic():
            return hall_of_fame.add_for_decision(
                decision,
                batch_label=batch_label_for(participation),
                achievement=policy.achievement_label or DEFAULT_ACHIEVEMENT,
            )
    except Exception:  # noqa: BLE001 - the Hall of Fame must never block a certificate
        logger.exception("certification.hall_of_fame_failed decision=%s", decision.pk)
        return None


def _on_pass(decision, participation, policy, *, actor=None):
    certificate = _issue_certificate(decision, participation, policy, actor=actor)
    if policy.auto_hall_of_fame:
        _add_to_hall_of_fame(decision, participation, policy)
    if policy.auto_deliver:
        plan_deliveries(decision, certificate)
    return certificate


# --- automatic decision ----------------------------------------------------------------------------------
def decide_participation(participation_id, *, now=None) -> CertificationDecision | None:
    """The single automatic decision for one participation (idempotent, race-safe)."""
    from apps.ctf.models import CtfParticipation

    now = now or timezone.now()
    with transaction.atomic():
        participation = (
            CtfParticipation.objects.select_for_update(of=("self",))  # nullable batch_course join
            .select_related("exam", "user", "batch_course")
            .filter(pk=participation_id)
            .first()
        )
        if participation is None or participation.is_staff_preview:
            return None
        policy = active_policy(participation.exam_id)
        if policy is None or not participation_ended(participation, now):
            return None
        existing = CertificationDecision.objects.filter(exam_id=participation.exam_id, user_id=participation.user_id).first()
        if existing is not None:
            return existing
        evaluation = grading.evaluate(participation, policy)
        try:
            with transaction.atomic():
                decision = CertificationDecision.objects.create(
                    exam_id=participation.exam_id,
                    user_id=participation.user_id,
                    participation=participation,
                    outcome=CertificationDecision.OUTCOME_PASSED if evaluation.passed else CertificationDecision.OUTCOME_FAILED,
                    score=evaluation.score,
                    total_points=evaluation.total_points,
                    percent=evaluation.percent,
                    band=evaluation.band,
                    sections=evaluation.sections,
                    reasons=evaluation.reasons,
                    pass_mark_percent=policy.pass_mark_percent,
                    section_minimums=policy.section_minimums or {},
                    answer_key_id=evaluation.answer_key_id,
                    decided_at=now,
                )
        except IntegrityError:
            return CertificationDecision.objects.get(exam_id=participation.exam_id, user_id=participation.user_id)
        _audit(decision, CertificationAudit.ACTION_DECIDED, after=_snapshot(decision), detail=evaluation.as_dict())
        if decision.passed:
            _on_pass(decision, participation, policy)
    logger.info(
        "certification.decided exam=%s user=%s outcome=%s percent=%s",
        decision.exam_id, decision.user_id, decision.outcome, decision.percent,
    )
    return decision


def queue_decision(participation_id) -> None:
    publish(EVENT_DECIDE, {"participation_id": int(participation_id)}, dedupe_key=f"cert-decide:{int(participation_id)}")


# --- re-grade --------------------------------------------------------------------------------------------
def _apply(decision, evaluation, policy):
    decision.outcome = CertificationDecision.OUTCOME_PASSED if evaluation.passed else CertificationDecision.OUTCOME_FAILED
    decision.score = evaluation.score
    decision.total_points = evaluation.total_points
    decision.percent = evaluation.percent
    decision.band = evaluation.band
    decision.sections = evaluation.sections
    decision.reasons = evaluation.reasons
    decision.pass_mark_percent = policy.pass_mark_percent
    decision.section_minimums = policy.section_minimums or {}
    decision.answer_key_id = evaluation.answer_key_id


def regrade_decision(decision, *, actor=None, reason="Answer key corrected") -> str:
    """Re-evaluate one decision. Returns unchanged | updated | upgraded | flagged | skipped."""
    with transaction.atomic():
        decision = (
            CertificationDecision.objects.select_for_update(of=("self",))
            .select_related("participation__exam", "participation__user", "participation__batch_course", "certificate")
            .get(pk=decision.pk)
        )
        participation = decision.participation
        policy = ExamCertificationPolicy.objects.filter(exam_id=decision.exam_id).first()
        if participation is None or policy is None:
            return "skipped"
        evaluation = grading.evaluate(participation, policy, reverify=True)
        before = _snapshot(decision)
        detail = evaluation.as_dict()
        if decision.passed and not evaluation.passed and decision.certificate_id and decision.certificate.revoked_at is None:
            decision.review_state = CertificationDecision.REVIEW_REVOCATION_PENDING
            decision.pending = detail
            decision.save(update_fields=["review_state", "pending", "updated_at"])
            _audit(decision, CertificationAudit.ACTION_REGRADE_FLAGGED, before=before,
                   after={"outcome": CertificationDecision.OUTCOME_FAILED, "percent": evaluation.percent},
                   actor=actor, reason=reason, detail=detail)
            return "flagged"
        upgraded = not decision.passed and evaluation.passed
        changed = (
            decision.outcome != ("passed" if evaluation.passed else "failed")
            or decision.score != evaluation.score
            or decision.total_points != evaluation.total_points
            or decision.sections != evaluation.sections
        )
        _apply(decision, evaluation, policy)
        decision.review_state = CertificationDecision.REVIEW_NONE
        decision.pending = None
        if changed:
            decision.revision += 1
        decision.save()
        _audit(decision, CertificationAudit.ACTION_REGRADED, before=before, after=_snapshot(decision), actor=actor,
               reason=reason, detail={**detail, "changed": changed})
        if upgraded:
            _on_pass(decision, participation, policy, actor=actor)
            return "upgraded"
        return "updated" if changed else "unchanged"


def regrade_exam(exam, *, actor=None, reason="Answer key corrected") -> dict:
    """Re-grade every decision of an exam and decide any ended participation still without one."""
    from apps.ctf.models import CtfParticipation

    stats = {"unchanged": 0, "updated": 0, "upgraded": 0, "flagged": 0, "skipped": 0, "decided": 0}
    for decision in CertificationDecision.objects.filter(exam=exam).order_by("pk"):
        stats[regrade_decision(decision, actor=actor, reason=reason)] += 1
    decided_users = CertificationDecision.objects.filter(exam=exam).values("user_id")
    for participation_id in (
        CtfParticipation.objects.filter(exam=exam, is_staff_preview=False)
        .exclude(user_id__in=decided_users)
        .values_list("pk", flat=True)
    ):
        if decide_participation(participation_id) is not None:
            stats["decided"] += 1
    logger.info("certification.regrade exam=%s %s", exam.pk, stats)
    return stats


def _reason(reason) -> str:
    text = " ".join(str(reason or "").split())
    if len(text) < 3:
        raise ValidationFailed(details={"reason": ["Give a short reason (at least 3 characters)."]})
    return text[:300]


def confirm_revocation(decision, *, actor, reason, request=None) -> CertificationDecision:
    """Staff confirm that a re-graded student no longer passes: revoke the certificate."""
    reason = _reason(reason)
    with transaction.atomic():
        decision = CertificationDecision.objects.select_for_update(of=("self",)).select_related("certificate").get(pk=decision.pk)
        if decision.review_state != CertificationDecision.REVIEW_REVOCATION_PENDING or not decision.pending:
            raise Conflict("This decision has no revocation waiting for confirmation.", code="certification_no_pending_revocation")
        before = _snapshot(decision)
        pending = decision.pending
        decision.outcome = CertificationDecision.OUTCOME_FAILED
        decision.score = int(pending.get("score") or 0)
        decision.total_points = int(pending.get("total_points") or 0)
        decision.percent = pending.get("percent") or "0"
        decision.band = ""
        decision.sections = pending.get("sections") or {}
        decision.reasons = pending.get("reasons") or []
        decision.answer_key_id = pending.get("answer_key_id") or decision.answer_key_id
        decision.review_state = CertificationDecision.REVIEW_NONE
        decision.pending = None
        decision.revision += 1
        decision.save()
        decision.refresh_from_db()
        if decision.certificate_id and decision.certificate.revoked_at is None:
            certificates.revoke(decision.certificate, actor=actor, reason=f"Re-grade: {reason}"[:300], request=request)
        from . import hall_of_fame

        for entry in HallOfFameEntry.objects.filter(Q(decision=decision) | Q(certificate_id=decision.certificate_id or 0)):
            if not entry.is_hidden:
                hall_of_fame.set_hidden(entry, hidden=True, actor=actor, reason=f"Certificate revoked: {reason}")
        _audit(decision, CertificationAudit.ACTION_REVOCATION_CONFIRMED, before=before, after=_snapshot(decision),
               actor=actor, reason=reason)
    return decision


def dismiss_revocation(decision, *, actor, reason) -> CertificationDecision:
    """Staff keep the pass (e.g. the answer-key change was wrong)."""
    reason = _reason(reason)
    with transaction.atomic():
        decision = CertificationDecision.objects.select_for_update().get(pk=decision.pk)
        if decision.review_state != CertificationDecision.REVIEW_REVOCATION_PENDING:
            raise Conflict("This decision has no revocation waiting for confirmation.", code="certification_no_pending_revocation")
        decision.review_state = CertificationDecision.REVIEW_NONE
        decision.pending = None
        decision.save(update_fields=["review_state", "pending", "updated_at"])
        _audit(decision, CertificationAudit.ACTION_REVOCATION_DISMISSED, before=_snapshot(decision),
               after=_snapshot(decision), actor=actor, reason=reason)
    return decision


# --- deliveries ------------------------------------------------------------------------------------------
def _mask_email(email: str) -> str:
    local, _, domain = str(email or "").partition("@")
    if not domain:
        return ""
    return f"{local[:1]}{'•' * max(1, min(6, len(local) - 1))}@{domain}"


def whatsapp_block_reason(user, prefs) -> str:
    """Why WhatsApp cannot be used for this student now ('' when it can)."""
    if prefs.whatsapp_opt_out:
        return "opted_out"
    config = whatsapp.config_from_settings()
    country = config.default_country_code if config else "91"
    if not whatsapp.normalize_phone(getattr(user, "phone_number", ""), country):
        return "no_phone"
    if config is None:
        return "whatsapp_not_configured"
    return ""


def channel_plan(user, prefs) -> dict[str, str]:
    """``{channel: ""}`` to send or ``{channel: reason}`` to skip, honouring preference and consent."""
    wa_block = whatsapp_block_reason(user, prefs)
    email_block = "" if str(getattr(user, "email", "") or "").strip() else "no_email"
    choice = prefs.delivery_channel
    plan = {
        CertificateDelivery.CHANNEL_EMAIL: email_block,
        CertificateDelivery.CHANNEL_WHATSAPP: wa_block,
    }
    if choice == CertificationPreferences.CHANNEL_EMAIL and not plan["whatsapp"]:
        plan["whatsapp"] = "preference_email_only"
    if choice == CertificationPreferences.CHANNEL_WHATSAPP and not plan["email"]:
        # E-mail only as a fallback when WhatsApp cannot deliver; the certificate must reach the student.
        plan["email"] = "" if plan["whatsapp"] else "preference_whatsapp_only"
    return plan


def _publish_delivery(delivery) -> None:
    publish(
        EVENT_DELIVER,
        {"delivery_id": delivery.pk, "round": delivery.round},
        dedupe_key=f"cert-deliver:{delivery.pk}:{delivery.round}",
    )


def plan_deliveries(decision, certificate) -> list[CertificateDelivery]:
    """Create one delivery row per channel (idempotent by ``<reference>:<channel>``) and queue the sends."""
    user = decision.user
    prefs = preferences_for(user)
    plan = channel_plan(user, prefs)
    rows = []
    for channel, skip in plan.items():
        key = f"{certificate.reference}:{channel}"
        if channel == CertificateDelivery.CHANNEL_EMAIL:
            hint = _mask_email(user.email)
        else:
            config = whatsapp.config_from_settings()
            hint = whatsapp.mask_phone(whatsapp.normalize_phone(user.phone_number, config.default_country_code if config else "91"))
        delivery, created = CertificateDelivery.objects.get_or_create(
            idempotency_key=key,
            defaults={
                "decision": decision,
                "certificate": certificate,
                "user": user,
                "channel": channel,
                "status": CertificateDelivery.STATUS_SKIPPED if skip else CertificateDelivery.STATUS_QUEUED,
                "skip_reason": skip,
                "destination_hint": hint[:80],
            },
        )
        if created and not skip:
            _publish_delivery(delivery)
        rows.append(delivery)
    return rows


def resend(delivery, *, actor, reason="Resent by staff") -> CertificateDelivery:
    """Staff resend: a new round with its own idempotency key. Consent is checked again; never overridden."""
    reason = _reason(reason)
    with transaction.atomic():
        row = CertificateDelivery.objects.select_for_update().select_related("user", "certificate", "decision").get(pk=delivery.pk)
        if row.certificate.revoked_at is not None:
            raise Conflict("The certificate is revoked; it cannot be sent.", code="certification_certificate_revoked")
        if row.status in (CertificateDelivery.STATUS_QUEUED, CertificateDelivery.STATUS_RETRYING):
            raise Conflict("This delivery is already queued.", code="certification_delivery_in_progress")
        if row.channel == CertificateDelivery.CHANNEL_WHATSAPP:
            block = whatsapp_block_reason(row.user, preferences_for(row.user))
        else:
            block = "" if str(row.user.email or "").strip() else "no_email"
        if block:
            raise ValidationFailed(
                f"Cannot send by {row.get_channel_display()}: {block.replace('_', ' ')}.",
                code="certification_delivery_blocked",
                details={"channel": [block]},
            )
        row.round += 1
        row.status = CertificateDelivery.STATUS_QUEUED
        row.skip_reason = ""
        row.last_error = ""
        row.provider_parts = {}
        row.queued_at = timezone.now()
        row.save()
        _audit(row.decision, CertificationAudit.ACTION_DELIVERY_RESENT, actor=actor, reason=reason,
               detail={"delivery_id": row.pk, "channel": row.channel, "round": row.round})
        _publish_delivery(row)
    return row


# --- read models -----------------------------------------------------------------------------------------
def decision_dict(decision, *, staff: bool = False) -> dict:
    data = {
        "id": decision.pk,
        "exam": {"slug": decision.exam.slug, "title": decision.exam.title},
        "outcome": decision.outcome,
        "band": decision.band,
        "percent": str(decision.percent),
        "score": decision.score,
        "total_points": decision.total_points,
        "pass_mark_percent": str(decision.pass_mark_percent),
        "sections": decision.sections,
        "decided_at": decision.decided_at.isoformat(),
        "certificate": None,
    }
    certificate = decision.certificate
    if certificate is not None:
        data["certificate"] = {
            "reference": certificate.reference,
            "valid": certificate.is_valid,
            "url": f"/certificates/{certificate.reference}",
            "letter_url": f"/api/certification/me/letters/{certificate.reference}/",
        }
    data["deliveries"] = [
        {
            "id": row.pk,
            "channel": row.channel,
            "status": row.status,
            "skip_reason": row.skip_reason,
            "sent_at": row.sent_at.isoformat() if row.sent_at else None,
            **({"attempts": row.attempts, "last_error": row.last_error, "provider_message_id": row.provider_message_id,
                "round": row.round, "destination_hint": row.destination_hint} if staff else {}),
        }
        for row in decision.deliveries.order_by("channel")
    ]
    if staff:
        data.update(
            {
                "user_id": decision.user_id,
                "revision": decision.revision,
                "review_state": decision.review_state,
                "pending": decision.pending,
                "reasons": decision.reasons,
                "audit": [
                    {
                        "action": row.action,
                        "outcome_before": row.outcome_before,
                        "outcome_after": row.outcome_after,
                        "percent_before": str(row.percent_before) if row.percent_before is not None else None,
                        "percent_after": str(row.percent_after) if row.percent_after is not None else None,
                        "reason": row.reason,
                        "actor_email": row.actor_email,
                        "created_at": row.created_at.isoformat(),
                    }
                    for row in decision.audit.order_by("created_at", "id")
                ],
            }
        )
    return data

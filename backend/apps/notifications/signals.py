from django.db.models.signals import post_save, pre_save
from django.dispatch import receiver


def _lecture_source_value(lecture):
    video_file_name = str(getattr(getattr(lecture, "video_file", None), "name", "") or "")
    video_key = str(getattr(lecture, "video_key", "") or "")
    return video_file_name or video_key


@receiver(pre_save, sender="courses.Lecture", dispatch_uid="notifications_capture_lecture_source")
def capture_lecture_source(sender, instance, **kwargs):
    if not getattr(instance, "pk", None):
        instance._notification_previous_source = None
        return
    previous = sender.objects.filter(pk=instance.pk).values("video_file", "video_key").first()
    if not previous:
        instance._notification_previous_source = None
        return
    instance._notification_previous_source = str(previous.get("video_file") or "") or str(
        previous.get("video_key") or ""
    )


@receiver(post_save, sender="courses.Lecture", dispatch_uid="notifications_lecture_uploaded")
def notify_lecture_uploaded(sender, instance, created, **kwargs):
    current_source = _lecture_source_value(instance)
    previous_source = getattr(instance, "_notification_previous_source", None)
    if not current_source:
        return
    if not created and previous_source == current_source:
        return
    from .services import notify_course_video_uploaded

    notify_course_video_uploaded(instance)


@receiver(pre_save, sender="realtime.RealtimeSession", dispatch_uid="notifications_capture_session_status")
def capture_session_status(sender, instance, **kwargs):
    if not getattr(instance, "pk", None):
        instance._notification_previous_status = None
        return
    previous = sender.objects.filter(pk=instance.pk).values("status").first()
    instance._notification_previous_status = previous.get("status") if previous else None


@receiver(post_save, sender="realtime.RealtimeSession", dispatch_uid="notifications_live_class_started")
def notify_session_live(sender, instance, created, **kwargs):
    previous_status = getattr(instance, "_notification_previous_status", None)
    if instance.status != sender.STATUS_LIVE:
        return
    if not created and previous_status == sender.STATUS_LIVE:
        return
    from .services import notify_live_class_started

    notify_live_class_started(instance)

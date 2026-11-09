from django import template

from apps.realtime.models import ServerResourceProfile

register = template.Library()


@register.inclusion_tag("realtime/admin/resource_profile_bar.html", takes_context=True)
def server_resource_profile_bar(context):
    request = context.get("request")
    user = getattr(request, "user", None)
    if not user or not user.has_perm("realtime.change_serverresourceprofile"):
        return {"visible": False}
    profile = ServerResourceProfile.get_solo()
    return {
        "visible": True,
        "profile": profile,
        "choices": [
            {
                "value": value,
                "label": label,
                "description": ServerResourceProfile.PROFILE_DESCRIPTIONS[value],
                "selected": value == profile.profile,
            }
            for value, label in ServerResourceProfile.PROFILE_CHOICES
        ],
        "applied_label": dict(ServerResourceProfile.PROFILE_CHOICES).get(profile.applied_profile, ""),
        "agent_online": profile.agent_online(),
        "in_sync": profile.in_sync(),
        "csrf_token": context.get("csrf_token"),
    }

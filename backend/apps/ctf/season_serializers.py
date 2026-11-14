"""Response/request shapes of ``/api/ctf/seasons/*`` (documentation + validation)."""

from rest_framework import serializers


class CosmeticsSerializer(serializers.Serializer):
    aura = serializers.BooleanField()
    frame = serializers.BooleanField()
    frame_tier = serializers.CharField(allow_blank=True)
    title = serializers.CharField(allow_blank=True)
    until = serializers.DateTimeField(allow_null=True)


class SeasonEntrySerializer(serializers.Serializer):
    joined = serializers.BooleanField()
    solved = serializers.BooleanField()
    solved_at = serializers.DateTimeField(allow_null=True)
    solve_seconds = serializers.IntegerField(allow_null=True)
    score_seconds = serializers.IntegerField(allow_null=True)
    attempts = serializers.IntegerField()
    wrong_attempts = serializers.IntegerField()
    attempts_left = serializers.IntegerField()
    disqualified = serializers.BooleanField()
    rank = serializers.IntegerField(allow_null=True)


class RewardRuleSerializer(serializers.Serializer):
    key = serializers.CharField()
    who = serializers.CharField()
    title = serializers.CharField()
    detail = serializers.CharField()
    lasts = serializers.CharField()


class SeasonSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = serializers.CharField()
    tagline = serializers.CharField(allow_blank=True)
    month = serializers.CharField()
    status = serializers.CharField()
    phase = serializers.ChoiceField(choices=["upcoming", "open", "closed", "results"])
    opens_at = serializers.DateTimeField()
    closes_at = serializers.DateTimeField()
    difficulty = serializers.CharField()
    skills = serializers.ListField(child=serializers.CharField())
    solvers = serializers.IntegerField()
    participants = serializers.IntegerField()
    penalty_seconds = serializers.IntegerField()
    max_attempts = serializers.IntegerField()
    solve_xp = serializers.IntegerField()
    can_play = serializers.BooleanField()
    play_reason = serializers.CharField(allow_blank=True)
    content_visible = serializers.BooleanField()
    brief = serializers.CharField(allow_blank=True, allow_null=True)
    question = serializers.CharField(allow_blank=True, allow_null=True)
    flag_format = serializers.CharField(allow_blank=True, allow_null=True)
    materials_url = serializers.CharField(allow_blank=True, allow_null=True)
    me = SeasonEntrySerializer(allow_null=True)


class CurrentSeasonSerializer(serializers.Serializer):
    season = SeasonSerializer(allow_null=True)
    rewards = RewardRuleSerializer(many=True)
    server_time = serializers.DateTimeField()


class LeaderboardRowSerializer(serializers.Serializer):
    rank = serializers.IntegerField()
    name = serializers.CharField()
    solved_at = serializers.DateTimeField()
    solve_seconds = serializers.IntegerField()
    wrong_attempts = serializers.IntegerField()
    attempts = serializers.IntegerField()
    score_seconds = serializers.IntegerField()
    first_blood = serializers.BooleanField()
    is_me = serializers.BooleanField()
    cosmetics = CosmeticsSerializer()


class LeaderboardSerializer(serializers.Serializer):
    season = serializers.CharField()
    final = serializers.BooleanField()
    solvers = serializers.IntegerField()
    participants = serializers.IntegerField()
    penalty_seconds = serializers.IntegerField()
    rows = LeaderboardRowSerializer(many=True)
    me = LeaderboardRowSerializer(allow_null=True)
    generated_at = serializers.DateTimeField()


class SubmitRequestSerializer(serializers.Serializer):
    answer = serializers.CharField(max_length=512, allow_blank=True, trim_whitespace=True)


class SubmitResponseSerializer(SeasonEntrySerializer):
    correct = serializers.BooleanField()
    practice = serializers.BooleanField()
    already_solved = serializers.BooleanField()


class RewardSerializer(serializers.Serializer):
    kind = serializers.CharField()
    title = serializers.CharField()
    season = serializers.CharField()
    month = serializers.CharField()
    rank = serializers.IntegerField(allow_null=True)
    tier = serializers.CharField(allow_blank=True)
    points = serializers.IntegerField()
    starts_at = serializers.DateTimeField()
    ends_at = serializers.DateTimeField(allow_null=True)
    active = serializers.BooleanField()
    permanent = serializers.BooleanField()
    streak = serializers.IntegerField(allow_null=True)
    certificate_slug = serializers.CharField(allow_null=True)


class MySeasonSummarySerializer(serializers.Serializer):
    handle = serializers.CharField()
    display_name = serializers.CharField()
    cosmetics = CosmeticsSerializer()
    streak_months = serializers.IntegerField()
    seasons_solved = serializers.IntegerField()
    xp_earned = serializers.IntegerField()
    trophies = RewardSerializer(many=True)
    badges = RewardSerializer(many=True)
    cosmetic_rewards = RewardSerializer(many=True)
    certificates = RewardSerializer(many=True)


class CosmeticsMapSerializer(serializers.Serializer):
    users = serializers.DictField(child=CosmeticsSerializer())


class HallOfFameRowSerializer(serializers.Serializer):
    rank = serializers.IntegerField()
    name = serializers.CharField()
    solve_seconds = serializers.IntegerField(allow_null=True)
    wrong_attempts = serializers.IntegerField()
    score_seconds = serializers.IntegerField(allow_null=True)
    tier = serializers.CharField(allow_blank=True)


class HallOfFameSeasonSerializer(serializers.Serializer):
    slug = serializers.CharField()
    title = serializers.CharField()
    month = serializers.CharField()
    solvers = serializers.IntegerField()
    finalised_at = serializers.DateTimeField(allow_null=True)
    finalists = HallOfFameRowSerializer(many=True)


class HallOfFameSerializer(serializers.Serializer):
    seasons = HallOfFameSeasonSerializer(many=True)


class CertificateSerializer(serializers.Serializer):
    valid = serializers.BooleanField()
    name = serializers.CharField()
    season = serializers.CharField()
    season_title = serializers.CharField()
    month = serializers.CharField()
    rank = serializers.IntegerField(allow_null=True)
    issued_at = serializers.DateTimeField()
    slug = serializers.CharField()

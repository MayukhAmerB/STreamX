"""Engagement: XP ledger, levels, streaks, badges, leaderboards and achievements.

Data flow: other apps' models emit signals; ``signals.py`` turns them into
transactional outbox events (or Redis write-behind counters for watch time and
live presence) and the async worker awards XP through ``services.award_many``.
Requests never aggregate the ledger: they read the denormalised
``EngagementSummary`` row (plus small cached extras).
"""

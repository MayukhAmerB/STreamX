"""Shared helpers for the engagement tests: an in-memory fake of the few
redis-py commands the app uses, and small builders."""

from __future__ import annotations

import fnmatch
from datetime import datetime, time

from django.core.cache import cache

from apps.core import features
from apps.engagement import buffer, rules
from apps.engagement.badges import AwardedItem


class FakePipeline:
    def __init__(self, client):
        self.client = client
        self.calls = []

    def __getattr__(self, name):
        def record(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return self

        return record

    def execute(self):
        results = [getattr(self.client, name)(*args, **kwargs) for name, args, kwargs in self.calls]
        self.calls = []
        return results


class FakeRedis:
    """Strings, hashes, sets and sorted sets; enough for apps.engagement."""

    def __init__(self):
        self.data: dict[str, object] = {}
        self.ttl: dict[str, int] = {}
        self.commands: list[str] = []

    def _log(self, name):
        self.commands.append(name)

    def pipeline(self, transaction=False):
        return FakePipeline(self)

    # keys
    def exists(self, key):
        self._log("exists")
        return int(key in self.data)

    def delete(self, *keys):
        self._log("delete")
        return sum(1 for key in keys if self.data.pop(key, None) is not None)

    def expire(self, key, seconds):
        self._log("expire")
        if key in self.data:
            self.ttl[key] = int(seconds)
            return True
        return False

    def rename(self, source, target):
        self._log("rename")
        if source not in self.data:
            raise Exception("ERR no such key")
        self.data[target] = self.data.pop(source)
        return True

    def keys(self, pattern="*"):
        return [key for key in self.data if fnmatch.fnmatch(key, pattern)]

    # strings
    def set(self, key, value, ex=None, get=False, nx=False):
        self._log("set")
        previous = self.data.get(key)
        if nx and previous is not None:
            return None
        self.data[key] = str(value)
        if ex:
            self.ttl[key] = int(ex)
        return previous if get else True

    def get(self, key):
        return self.data.get(key)

    # hashes
    def hincrby(self, key, field, amount):
        self._log("hincrby")
        bucket = self.data.setdefault(key, {})
        bucket[field] = int(bucket.get(field, 0)) + int(amount)
        return bucket[field]

    def hgetall(self, key):
        self._log("hgetall")
        return dict(self.data.get(key) or {})

    # sets
    def sadd(self, key, *members):
        self.data.setdefault(key, set()).update(members)

    def srem(self, key, *members):
        self.data.get(key, set()).difference_update(members)

    def smembers(self, key):
        return set(self.data.get(key) or set())

    # sorted sets
    def _z(self, key):
        return self.data.setdefault(key, {})

    def zadd(self, key, mapping):
        self._log("zadd")
        self._z(key).update({str(member): float(score) for member, score in mapping.items()})
        return len(mapping)

    def zrem(self, key, *members):
        self._log("zrem")
        zset = self.data.get(key) or {}
        return sum(1 for member in members if zset.pop(str(member), None) is not None)

    def _ordered(self, key):
        zset = self.data.get(key) or {}
        return sorted(zset.items(), key=lambda pair: (-pair[1], pair[0]))

    def zrevrange(self, key, start, stop, withscores=False):
        self._log("zrevrange")
        rows = self._ordered(key)
        stop = len(rows) - 1 if stop == -1 else stop
        rows = rows[start : stop + 1]
        return [(member.encode(), score) for member, score in rows] if withscores else [m.encode() for m, _ in rows]

    def zrevrank(self, key, member):
        self._log("zrevrank")
        for index, (name, _score) in enumerate(self._ordered(key)):
            if name == str(member):
                return index
        return None

    def zcount(self, key, low, high):
        self._log("zcount")
        exclusive = str(low).startswith("(")
        low_value = float(str(low).lstrip("("))
        zset = self.data.get(key) or {}
        return sum(1 for score in zset.values() if (score > low_value if exclusive else score >= low_value))

    def zcard(self, key):
        return len(self.data.get(key) or {})

    def zscore(self, key, member):
        return (self.data.get(key) or {}).get(str(member))


def reset_engagement_state():
    cache.clear()
    # A switch flipped inside a TestCase transaction never commits, which would
    # leave this thread reading switches from the database (query counts).
    features._pending.dirty = False
    features.invalidate_cache()
    buffer.reset_local_for_tests()
    buffer._client_override = None
    # The engagement presence alias also feeds attendance's in-process buffer:
    # clear it too, or pings left by one test are flushed into a later test's
    # session (SQLite reuses primary keys after a TestCase rollback).
    from apps.attendance import buffer as attendance_buffer

    attendance_buffer.reset_local_for_tests()
    attendance_buffer._client_override = None


def ist(year, month, day, hour=12, minute=0):
    return datetime.combine(datetime(year, month, day).date(), time(hour, minute), tzinfo=rules.IST)


def item(kind, points, key, *, occurred_at=None, source_type="day", source_id="", **ctx):
    return AwardedItem(kind=kind, points=points, key=key, source_type=source_type, source_id=source_id,
                       occurred_at=occurred_at, ctx=ctx)


def drain():
    from apps.core.outbox import drain_outbox

    total = {"delivered": 0, "dead": 0, "retried": 0}
    for _ in range(20):
        stats = drain_outbox(batch_size=100)
        for key in total:
            total[key] += stats[key]
        if not stats["claimed"]:
            break
    return total

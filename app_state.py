"""
app_state.py — Per-session state management for Data Talk.

Replaces the old singleton AppState with a SessionManager that
isolates state per user_id (from Supabase Auth JWT).
Thread-safe via threading.Lock.
"""

import collections
import threading
import time
from collections import deque

import app_config


class QueryCache:
    """Simple bounded in-memory cache to prevent unbounded growth."""

    def __init__(self, max_items=200):
        self.max_items = max_items
        self._cache = collections.OrderedDict()
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            value = self._cache.get(key)
            if value is None:
                return None
            self._cache.move_to_end(key)
            return value

    def set(self, key, value):
        with self._lock:
            self._cache[key] = value
            self._cache.move_to_end(key)
            while len(self._cache) > self.max_items:
                self._cache.popitem(last=False)

    def clear(self):
        with self._lock:
            self._cache.clear()

    def __contains__(self, key):
        with self._lock:
            return key in self._cache


class UserState:
    """Per-user runtime state container."""

    def __init__(self):
        self.chat_history: list[dict[str, object]] = []
        self.chat_sessions: list[dict[str, object]] = []
        self.active_session_id: str | None = None
        self.active_file: dict[str, str | None] = {"filename": None}
        self.dashboard_store_cache: dict[str, object] | None = None
        self.dashboard_store_cached_at: float | None = None
        self.usage_totals: dict[str, object] = {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
            "cost_myr": 0.0,
            "updated_at": None,
        }
        self.message_request_times = deque(maxlen=300)
        self.query_cache = QueryCache(max_items=app_config.QUERY_CACHE_SIZE)
        self._file_cache: dict[str, dict] = {}
        self._file_locks: dict[str, threading.Lock] = {}
        self._file_locks_guard = threading.Lock()

    def get_cached(self, filename, key):
        """Get a cached computation for a file, or None."""
        return self._file_cache.get(filename, {}).get(key)

    def set_cached(self, filename, key, value):
        """Cache a computation result for a file."""
        if filename not in self._file_cache:
            self._file_cache[filename] = {}
        self._file_cache[filename][key] = value

    def clear_file_cache(self):
        """Invalidate all cached file computations."""
        self._file_cache.clear()

    def get_file_lock(self, filename):
        """Return a stable lock object for a dataset path to dedupe concurrent loads."""
        with self._file_locks_guard:
            lock = self._file_locks.get(filename)
            if lock is None:
                lock = threading.Lock()
                self._file_locks[filename] = lock
            return lock


class SessionManager:
    """
    Manages per-user state instances.
    Thread-safe: each user_id gets their own UserState.
    """

    def __init__(self):
        self._sessions: dict[str, tuple[UserState, float]] = {}
        self._lock = threading.Lock()

    def _evict_expired(self, now: float):
        """Evict expired sessions. Assumes lock is held."""
        expired = [
            uid for uid, (_, last_accessed) in self._sessions.items()
            if now - last_accessed > app_config.SESSION_TTL_SECONDS
        ]
        for uid in expired:
            self._sessions.pop(uid, None)

    def get_state(self, user_id: str) -> UserState:
        """Get or create state for a user. Thread-safe."""
        now = time.time()
        with self._lock:
            self._evict_expired(now)
            if user_id not in self._sessions:
                self._sessions[user_id] = (UserState(), now)
            else:
                self._sessions[user_id] = (self._sessions[user_id][0], now)
            return self._sessions[user_id][0]

    def remove_state(self, user_id: str):
        """Remove a user's state (e.g., on logout)."""
        with self._lock:
            self._sessions.pop(user_id, None)

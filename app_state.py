"""
app_state.py — Per-session state management for Data Talk.

Replaces the old singleton AppState with a SessionManager that
isolates state per user_id (from Supabase Auth JWT).
Thread-safe via threading.Lock.
"""

import collections
import threading

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
        self.chat_histories: dict[str, list[dict[str, object]]] = {}
        self.active_file: dict[str, str | None] = {"filename": None}
        self.query_cache = QueryCache(max_items=app_config.QUERY_CACHE_SIZE)
        self._file_cache: dict[str, dict] = {}

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


class SessionManager:
    """
    Manages per-user state instances.
    Thread-safe: each user_id gets their own UserState.
    """

    def __init__(self):
        self._sessions: dict[str, UserState] = {}
        self._lock = threading.Lock()

    def get_state(self, user_id: str) -> UserState:
        """Get or create state for a user. Thread-safe."""
        with self._lock:
            if user_id not in self._sessions:
                self._sessions[user_id] = UserState()
            return self._sessions[user_id]

    def remove_state(self, user_id: str):
        """Remove a user's state (e.g., on logout)."""
        with self._lock:
            self._sessions.pop(user_id, None)

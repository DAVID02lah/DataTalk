"""Shared in-memory application state for Data Talk."""

import collections


class QueryCache:
    """Simple bounded in-memory cache to prevent unbounded growth."""

    def __init__(self, max_items=200):
        self.max_items = max_items
        self._cache = collections.OrderedDict()

    def get(self, key):
        value = self._cache.get(key)
        if value is None:
            return None
        self._cache.move_to_end(key)
        return value

    def set(self, key, value):
        self._cache[key] = value
        self._cache.move_to_end(key)
        while len(self._cache) > self.max_items:
            self._cache.popitem(last=False)

    def clear(self):
        self._cache.clear()

    def __contains__(self, key):
        return key in self._cache


class AppState:
    """Container for mutable global runtime state."""

    def __init__(self):
        self.chat_histories: dict[str, list[dict[str, object]]] = {}
        self.active_file: dict[str, str | None] = {"filename": None}
        self.query_cache = QueryCache(max_items=300)

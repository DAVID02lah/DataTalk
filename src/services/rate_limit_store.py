"""rate_limit_store.py — Persist rate-limit timestamps to Supabase.

Bridges the in-memory sliding-window deque with the durable profiles
table so that rate limits survive logout, session eviction, and server
restarts.  Uses the service-role client to bypass RLS.
"""

from __future__ import annotations

import json
import logging
import time
from collections import deque
from typing import Any

from src.services import auth_service

logger = logging.getLogger("data_talk.rate_limit_store")

_COLUMN = "rate_limit_timestamps"


def load_timestamps(user_id: str) -> list[float]:
    """Fetch persisted rate-limit timestamps from the profiles table."""
    try:
        sb = auth_service.get_supabase_service()
        result = (
            sb.table("profiles")
            .select(_COLUMN)
            .eq("id", user_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            return []
        raw = result.data.get(_COLUMN)
        if not raw:
            return []
        # Column may arrive as a JSON string or native list depending on driver.
        timestamps = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(timestamps, list):
            return []
        return [float(ts) for ts in timestamps if _is_valid_timestamp(ts)]
    except Exception as exc:
        logger.warning("Failed to load rate-limit timestamps for %s: %s", user_id, exc)
        return []


def save_timestamps(user_id: str, timestamps: list[float] | deque) -> None:
    """Write the current sliding-window timestamps to the profiles table."""
    try:
        sb = auth_service.get_supabase_service()
        serialisable = [round(ts, 3) for ts in timestamps]
        sb.table("profiles").update(
            {_COLUMN: serialisable}
        ).eq("id", user_id).execute()
    except Exception as exc:
        logger.warning("Failed to save rate-limit timestamps for %s: %s", user_id, exc)


def rehydrate_into_state(state, user_id: str, rate_limit: str) -> None:
    """Load persisted timestamps into the in-memory deque, evicting expired entries."""
    from src.services.usage_service import _parse_rate_limit, _evict_expired_requests, ensure_usage_state

    ensure_usage_state(state)
    persisted = load_timestamps(user_id)
    if not persisted:
        return

    _limit, window_seconds = _parse_rate_limit(rate_limit)
    cutoff = time.time() - window_seconds

    # Merge persisted timestamps that are still within the active window.
    for ts in persisted:
        if ts >= cutoff:
            state.message_request_times.append(ts)

    # Ensure chronological order after merge.
    sorted_times = sorted(state.message_request_times)
    state.message_request_times.clear()
    state.message_request_times.extend(sorted_times)


def _is_valid_timestamp(value: Any) -> bool:
    """Guard against corrupted DB values."""
    try:
        ts = float(value)
        # Sanity: reject timestamps before 2020 or far in the future.
        return 1_577_836_800 < ts < time.time() + 86_400
    except (TypeError, ValueError):
        return False

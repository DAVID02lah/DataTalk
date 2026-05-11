"""Dashboard persistence helpers.

This module keeps dashboard-shape migration and session-scoping in one place so
route handlers can stay focused on request/response concerns.
"""

from __future__ import annotations

from collections.abc import Mapping
import time
from typing import Any

from src.core import app_config
from src.services import auth_service




def empty_session_dashboard() -> dict[str, list[Any]]:
    """Use a single constructor to keep empty payloads structurally identical."""
    return {"charts": [], "cards": []}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _normalise_session_payload(payload: Any) -> dict[str, list[Any]]:
    """Defensively coerce session payloads to avoid runtime type branching later."""
    if not isinstance(payload, dict):
        return empty_session_dashboard()
    return {
        "charts": _as_list(payload.get("charts")),
        "cards": _as_list(payload.get("cards")),
    }


def normalise_dashboard_store(raw_config: Any, fallback_session_id: str) -> dict[str, Any]:
    """Normalize legacy dashboard configs into the per-session store schema."""
    if isinstance(raw_config, dict) and isinstance(raw_config.get("sessions"), dict):
        store = raw_config
    else:
        legacy_charts = []
        legacy_cards = []
        if isinstance(raw_config, dict):
            legacy_charts = _as_list(raw_config.get("charts"))
            legacy_cards = _as_list(raw_config.get("cards"))

        store = {
            "sessions": {},
        }
        if legacy_charts or legacy_cards:
            store["sessions"][fallback_session_id] = {
                "charts": legacy_charts,
                "cards": legacy_cards,
            }

    raw_sessions = store.get("sessions")
    sessions: dict[str, dict[str, list[Any]]] = {}
    if isinstance(raw_sessions, dict):
        for session_id, payload in raw_sessions.items():
            sessions[str(session_id)] = _normalise_session_payload(payload)

    sessions.setdefault(fallback_session_id, empty_session_dashboard())
    store["sessions"] = sessions

    return store


def _is_dashboard_cache_fresh(state) -> bool:
    if state is None:
        return False
    cache = getattr(state, "dashboard_store_cache", None)
    cached_at = getattr(state, "dashboard_store_cached_at", None)
    if not isinstance(cache, dict) or not isinstance(cached_at, (int, float)):
        return False

    ttl_seconds = max(1, int(app_config.DASHBOARD_STORE_CACHE_TTL_SECONDS or 1))
    return (time.time() - float(cached_at)) <= ttl_seconds


def load_dashboard_store(user_id: str, session_id: str, state=None) -> dict[str, Any]:
    """Read dashboard config and always return normalized structure."""
    if _is_dashboard_cache_fresh(state):
        cached_store = getattr(state, "dashboard_store_cache", None)
        return normalise_dashboard_store(cached_store, session_id)

    sb_service = auth_service.get_supabase_service()
    result = sb_service.table("dashboard_configs").select("config").eq("user_id", user_id).execute()
    raw_config = result.data[0]["config"] if (result.data and len(result.data) > 0) else {}
    store = normalise_dashboard_store(raw_config, session_id)

    if state is not None:
        state.dashboard_store_cache = store
        state.dashboard_store_cached_at = time.time()

    return store


def save_dashboard_store(user_id: str, config: dict[str, Any], state=None) -> None:
    """Persist normalized store so all readers observe one canonical format."""
    sb_service = auth_service.get_supabase_service()
    sb_service.table("dashboard_configs").upsert({
        "user_id": user_id,
        "config": config,
        "updated_at": "now()",
    }, on_conflict="user_id").execute()

    if state is not None:
        state.dashboard_store_cache = config
        state.dashboard_store_cached_at = time.time()


def get_session_dashboard(config: Mapping[str, Any], session_id: str) -> dict[str, list[Any]]:
    """Return a normalized session dashboard payload from a full store object."""
    sessions = config.get("sessions") if isinstance(config, Mapping) else {}
    if not isinstance(sessions, Mapping):
        return empty_session_dashboard()
    return _normalise_session_payload(sessions.get(session_id))

"""Dashboard persistence helpers.

This module keeps dashboard-shape migration and session-scoping in one place so
route handlers can stay focused on request/response concerns.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import auth_service
import chat_session_service
from errors import ValidationError

_DASHBOARD_STORE_VERSION = 2


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
            "version": _DASHBOARD_STORE_VERSION,
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
    store["version"] = _DASHBOARD_STORE_VERSION
    return store


def resolve_requested_session_id(
    state,
    request_args: Mapping[str, Any] | None = None,
    request_data: Mapping[str, Any] | None = None,
) -> str:
    """Resolve and activate request session ids to prevent cross-session writes."""
    requested = ""
    if isinstance(request_data, Mapping):
        requested = str(request_data.get("session_id") or "").strip()

    if not requested and isinstance(request_args, Mapping):
        requested = str(request_args.get("session_id") or "").strip()

    if requested:
        active = chat_session_service.set_active_session(state, requested)
        if not active:
            raise ValidationError("Invalid session_id")
        return requested

    active = chat_session_service.ensure_active_session(
        state,
        filename=state.active_file.get("filename"),
    )
    return str(active.get("id") or "")


def load_dashboard_store(user_id: str, session_id: str) -> dict[str, Any]:
    """Read dashboard config and always return normalized structure."""
    sb_service = auth_service.get_supabase_service()
    result = sb_service.table("dashboard_configs").select("config").eq("user_id", user_id).execute()
    raw_config = result.data[0]["config"] if (result.data and len(result.data) > 0) else {}
    return normalise_dashboard_store(raw_config, session_id)


def save_dashboard_store(user_id: str, config: dict[str, Any]) -> None:
    """Persist normalized store so all readers observe one canonical format."""
    sb_service = auth_service.get_supabase_service()
    sb_service.table("dashboard_configs").upsert({
        "user_id": user_id,
        "config": config,
        "updated_at": "now()",
    }, on_conflict="user_id").execute()


def get_session_dashboard(config: Mapping[str, Any], session_id: str) -> dict[str, list[Any]]:
    """Return a normalized session dashboard payload from a full store object."""
    sessions = config.get("sessions") if isinstance(config, Mapping) else {}
    if not isinstance(sessions, Mapping):
        return empty_session_dashboard()
    return _normalise_session_payload(sessions.get(session_id))

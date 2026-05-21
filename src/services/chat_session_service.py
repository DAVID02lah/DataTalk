"""Chat session and persistence helpers for Data Talk."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any
import uuid

from src.core.errors import ValidationError


def now_iso() -> str:
    """Return a UTC timestamp in ISO format."""
    return datetime.now(timezone.utc).isoformat()


def make_session_id() -> str:
    """Create a unique chat session id."""
    return f"session_{uuid.uuid4().hex}"


def _clean_messages(raw_messages: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_messages, list):
        return []

    cleaned: list[dict[str, Any]] = []
    for msg in raw_messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        text = msg.get("text")
        if role not in {"user", "model", "ai"}:
            continue
        cleaned.append({
            "role": "model" if role == "ai" else role,
            "text": str(text or ""),
            "chart": msg.get("chart"),
            "table": msg.get("table"),
            "stats": msg.get("stats"),
            "created_at": msg.get("created_at") or now_iso(),
        })
    return cleaned


def _derive_title(messages: list[dict[str, Any]], fallback: str = "New Conversation") -> str:
    for msg in messages:
        if msg.get("role") == "user":
            text = str(msg.get("text") or "").strip()
            if text:
                return text[:80]
    return fallback


def create_session(filename: str | None, title: str | None = None) -> dict[str, Any]:
    ts = now_iso()
    return {
        "id": make_session_id(),
        "title": (title or "New Conversation")[:80],
        "filename": filename,
        "created_at": ts,
        "updated_at": ts,
        "messages": [],
        "token_usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
            "cost_myr": 0.0,
        },
    }


def _session_updated_at(session: dict[str, Any]) -> str:
    return str(session.get("updated_at") or "")


def _sorted_sessions_by_recent(sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(sessions, key=_session_updated_at, reverse=True)


def enforce_session_limit(state, max_sessions: int) -> None:
    """Keep only the most relevant sessions so runtime memory remains bounded."""
    max_sessions = max(1, int(max_sessions or 1))

    sessions = getattr(state, "chat_sessions", None)
    if not isinstance(sessions, list):
        state.chat_sessions = []
        state.active_session_id = None
        state.chat_history = []
        return

    if len(sessions) <= max_sessions:
        return

    active_session_id = getattr(state, "active_session_id", None)
    ordered_sessions = _sorted_sessions_by_recent(sessions)

    kept_sessions: list[dict[str, Any]] = []
    if active_session_id:
        active_session = next(
            (session for session in ordered_sessions if session.get("id") == active_session_id),
            None,
        )
        if active_session is not None:
            kept_sessions.append(active_session)

    for session in ordered_sessions:
        if len(kept_sessions) >= max_sessions:
            break
        if any(existing.get("id") == session.get("id") for existing in kept_sessions):
            continue
        kept_sessions.append(session)

    state.chat_sessions = kept_sessions

    if not kept_sessions:
        state.active_session_id = None
        state.chat_history = []
        if isinstance(getattr(state, "active_file", None), dict):
            state.active_file["filename"] = None
        return

    kept_ids = {session.get("id") for session in kept_sessions}
    if state.active_session_id not in kept_ids:
        state.active_session_id = kept_sessions[0].get("id")

    active_session = next(
        (session for session in kept_sessions if session.get("id") == state.active_session_id),
        None,
    )
    if active_session is None:
        active_session = kept_sessions[0]
        state.active_session_id = active_session.get("id")
    state.chat_history = _clean_messages(active_session.get("messages"))
    active_session["messages"] = state.chat_history

    if isinstance(getattr(state, "active_file", None), dict):
        state.active_file["filename"] = active_session.get("filename")


def ensure_active_session(state, filename: str | None = None, force_new: bool = False) -> dict[str, Any]:
    """Ensure state has an active conversation session and return it."""
    if not hasattr(state, "chat_sessions") or not isinstance(state.chat_sessions, list):
        state.chat_sessions = []

    if not hasattr(state, "active_session_id"):
        state.active_session_id = None

    if force_new or not state.active_session_id:
        session = create_session(filename=filename)
        state.chat_sessions.insert(0, session)
        state.active_session_id = session["id"]
        state.chat_history = session["messages"]
        return session

    for session in state.chat_sessions:
        if session.get("id") == state.active_session_id:
            if filename is not None and not session.get("filename"):
                session["filename"] = filename
            state.chat_history = _clean_messages(session.get("messages"))
            session["messages"] = state.chat_history
            return session

    # Active id not found, create a replacement session.
    session = create_session(filename=filename)
    state.chat_sessions.insert(0, session)
    state.active_session_id = session["id"]
    state.chat_history = session["messages"]
    return session


def resolve_requested_session_id(
    state,
    request_args: Mapping[str, Any] | None = None,
    request_data: Mapping[str, Any] | None = None,
) -> str:
    """Resolve a requested session id and activate it so dashboard writes stay scoped."""
    requested = ""
    if isinstance(request_data, Mapping):
        requested = str(request_data.get("session_id") or "").strip()

    if not requested and isinstance(request_args, Mapping):
        requested = str(request_args.get("session_id") or "").strip()

    if requested:
        active = set_active_session(state, requested)
        if not active:
            raise ValidationError("Invalid session_id")
        return requested

    active = ensure_active_session(
        state,
        filename=state.active_file.get("filename"),
    )
    return str(active.get("id") or "")


def set_active_session(state, session_id: str) -> dict[str, Any] | None:
    for session in getattr(state, "chat_sessions", []):
        if session.get("id") == session_id:
            state.active_session_id = session_id
            state.chat_history = _clean_messages(session.get("messages"))
            session["messages"] = state.chat_history
            if not session.get("updated_at"):
                session["updated_at"] = now_iso()
            return session
    return None


def delete_session(state, session_id: str) -> bool:
    sessions = getattr(state, "chat_sessions", [])
    before = len(sessions)
    sessions[:] = [s for s in sessions if s.get("id") != session_id]
    if len(sessions) == before:
        return False

    if state.active_session_id == session_id:
        if sessions:
            state.active_session_id = sessions[0].get("id")
            state.chat_history = _clean_messages(sessions[0].get("messages"))
            sessions[0]["messages"] = state.chat_history
        else:
            state.active_session_id = None
            state.chat_history = []
    return True


def append_exchange(state, user_text: str, model_result: dict[str, Any]) -> None:
    session = ensure_active_session(state, filename=state.active_file.get("filename"))
    messages = _clean_messages(session.get("messages"))

    messages.append({
        "role": "user",
        "text": user_text,
        "chart": None,
        "table": None,
        "stats": None,
        "created_at": now_iso(),
    })
    messages.append({
        "role": "model",
        "text": str(model_result.get("text") or ""),
        "chart": model_result.get("chart"),
        "table": model_result.get("table"),
        "stats": model_result.get("stats"),
        "created_at": now_iso(),
    })

    session["messages"] = messages
    session["updated_at"] = now_iso()
    if session.get("title") in {None, "", "New Conversation"}:
        session["title"] = _derive_title(messages)

    state.chat_history = messages


def get_active_messages(state, active_session: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Return messages from the active session, reusing a pre-resolved session when available."""
    session = active_session or ensure_active_session(state, filename=state.active_file.get("filename"))
    messages = _clean_messages(session.get("messages"))
    session["messages"] = messages
    state.chat_history = messages
    return messages


def list_session_summaries(state) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for session in getattr(state, "chat_sessions", []):
        messages = session.get("messages")
        if session.get("title"):
            message_count = len(messages) if isinstance(messages, list) else 0
            title = session.get("title")
        else:
            messages = _clean_messages(messages)
            message_count = len(messages)
            title = _derive_title(messages)
        result.append({
            "id": session.get("id"),
            "title": title,
            "filename": session.get("filename"),
            "created_at": session.get("created_at"),
            "updated_at": session.get("updated_at"),
            "message_count": message_count,
            "is_active": session.get("id") == getattr(state, "active_session_id", None),
        })
    # Most recently updated first.
    result.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return result


def build_persisted_payload(state) -> dict[str, Any]:
    sessions = []
    for session in getattr(state, "chat_sessions", []):
        cleaned_messages = _clean_messages(session.get("messages"))
        sessions.append({
            "id": session.get("id"),
            "title": session.get("title") or _derive_title(cleaned_messages),
            "filename": session.get("filename"),
            "created_at": session.get("created_at") or now_iso(),
            "updated_at": session.get("updated_at") or now_iso(),
            "messages": cleaned_messages,
            "token_usage": session.get("token_usage") or {
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "cost_usd": 0.0,
                "cost_myr": 0.0,
            },
        })

    usage = getattr(state, "usage_totals", None) or {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "cost_myr": 0.0,
    }

    return {
        "active_session_id": getattr(state, "active_session_id", None),
        "sessions": sessions,
        "usage_totals": usage,
    }


def restore_from_persisted_payload(state, payload: Any, user_id: str, fallback_filename: str | None = None) -> None:
    """Restore session state from either legacy or v2 payloads."""
    state.chat_sessions = []
    state.active_session_id = None
    state.chat_history = []

    # New payload format
    if isinstance(payload, dict) and isinstance(payload.get("sessions"), list):
        for raw in payload.get("sessions", []):
            if not isinstance(raw, dict):
                continue
            messages = _clean_messages(raw.get("messages"))
            session = {
                "id": raw.get("id") or make_session_id(),
                "title": (raw.get("title") or _derive_title(messages))[:80],
                "filename": raw.get("filename") or fallback_filename,
                "created_at": raw.get("created_at") or now_iso(),
                "updated_at": raw.get("updated_at") or now_iso(),
                "messages": messages,
                "token_usage": raw.get("token_usage") or {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "total_tokens": 0,
                    "cost_usd": 0.0,
                    "cost_myr": 0.0,
                },
            }
            state.chat_sessions.append(session)

        loaded_usage = payload.get("usage_totals")
        if loaded_usage:
            state.usage_totals = loaded_usage

        state.active_session_id = payload.get("active_session_id")
        active = set_active_session(state, state.active_session_id or "")
        if active is None and state.chat_sessions:
            state.active_session_id = state.chat_sessions[0]["id"]
            state.chat_history = state.chat_sessions[0]["messages"]
        elif active is None and not state.chat_sessions:
            session = create_session(filename=fallback_filename)
            state.chat_sessions.append(session)
            state.active_session_id = session["id"]
            state.chat_history = session["messages"]
        return

    # Legacy format: list of messages or {user_id:[messages]}.
    legacy_messages = []
    if isinstance(payload, list):
        legacy_messages = _clean_messages(payload)
    elif isinstance(payload, dict):
        maybe_user_history = payload.get(user_id)
        if isinstance(maybe_user_history, list):
            legacy_messages = _clean_messages(maybe_user_history)
        else:
            for value in payload.values():
                if isinstance(value, list):
                    legacy_messages = _clean_messages(value)
                    break

    session = create_session(filename=fallback_filename, title=_derive_title(legacy_messages))
    session["messages"] = legacy_messages
    if legacy_messages:
        session["updated_at"] = now_iso()
    state.chat_sessions = [session]
    state.active_session_id = session["id"]
    state.chat_history = legacy_messages

    if not getattr(state, "usage_totals", None):
        state.usage_totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
            "cost_myr": 0.0,
        }

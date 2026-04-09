"""Usage and rate-budget tracking helpers for Data Talk."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from typing import Any
import re
import time

TOKEN_PRICING_USD_PER_MILLION = {
    "input": 0.25,
    "output": 1.50,
}


def _as_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def calculate_cost_usd(input_tokens: int, output_tokens: int) -> float:
    return (
        (input_tokens / 1_000_000.0) * TOKEN_PRICING_USD_PER_MILLION["input"]
        + (output_tokens / 1_000_000.0) * TOKEN_PRICING_USD_PER_MILLION["output"]
    )


def ensure_usage_state(state) -> None:
    if not hasattr(state, "usage_totals") or not isinstance(state.usage_totals, dict):
        state.usage_totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
            "cost_myr": 0.0,
            "updated_at": None,
        }

    if not hasattr(state, "message_request_times"):
        state.message_request_times = deque(maxlen=300)


def record_token_usage(state, usage: dict[str, Any] | None, usd_to_myr_rate: float) -> dict[str, Any]:
    ensure_usage_state(state)
    if not usage:
        return state.usage_totals

    input_tokens = _as_int(usage.get("input_tokens"))
    output_tokens = _as_int(usage.get("output_tokens"))
    total_tokens = _as_int(usage.get("total_tokens"))

    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens

    cost_usd = calculate_cost_usd(input_tokens, output_tokens)
    cost_myr = cost_usd * float(usd_to_myr_rate or 0.0)

    state.usage_totals["input_tokens"] = _as_int(state.usage_totals.get("input_tokens")) + input_tokens
    state.usage_totals["output_tokens"] = _as_int(state.usage_totals.get("output_tokens")) + output_tokens
    state.usage_totals["total_tokens"] = _as_int(state.usage_totals.get("total_tokens")) + total_tokens
    state.usage_totals["cost_usd"] = float(state.usage_totals.get("cost_usd") or 0.0) + cost_usd
    state.usage_totals["cost_myr"] = float(state.usage_totals.get("cost_myr") or 0.0) + cost_myr
    state.usage_totals["updated_at"] = datetime.now(timezone.utc).isoformat()

    active_session_id = getattr(state, "active_session_id", None)
    for session in getattr(state, "chat_sessions", []):
        if session.get("id") != active_session_id:
            continue
        token_usage = session.get("token_usage") or {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
            "cost_myr": 0.0,
        }
        token_usage["input_tokens"] = _as_int(token_usage.get("input_tokens")) + input_tokens
        token_usage["output_tokens"] = _as_int(token_usage.get("output_tokens")) + output_tokens
        token_usage["total_tokens"] = _as_int(token_usage.get("total_tokens")) + total_tokens
        token_usage["cost_usd"] = float(token_usage.get("cost_usd") or 0.0) + cost_usd
        token_usage["cost_myr"] = float(token_usage.get("cost_myr") or 0.0) + cost_myr
        session["token_usage"] = token_usage
        break

    return state.usage_totals


def _parse_rate_limit(rate_limit: str) -> tuple[int, int]:
    """Parse strings like '5 per minute'. Returns (limit, window_seconds)."""
    if not rate_limit:
        return 5, 60

    match = re.match(r"\s*(\d+)\s+per\s+(second|minute|hour|day)s?\s*", str(rate_limit), re.IGNORECASE)
    if not match:
        return 5, 60

    limit = int(match.group(1))
    unit = match.group(2).lower()
    unit_seconds = {
        "second": 1,
        "minute": 60,
        "hour": 3600,
        "day": 86400,
    }[unit]

    return limit, unit_seconds


def _evict_expired_requests(state, cutoff: float) -> None:
    """Remove timestamps older than the rate-limit window from the sliding window deque."""
    while state.message_request_times and state.message_request_times[0] < cutoff:
        state.message_request_times.popleft()


def record_message_request(state, rate_limit: str, now_ts: float | None = None) -> None:
    ensure_usage_state(state)
    now_val = now_ts if now_ts is not None else time.time()
    limit, window_seconds = _parse_rate_limit(rate_limit)

    # Trim expired entries before counting to keep the window accurate.
    _evict_expired_requests(state, now_val - window_seconds)

    if len(state.message_request_times) < max(limit, 1):
        state.message_request_times.append(now_val)
    else:
        # Keep append semantics for exact remaining-time computation.
        state.message_request_times.append(now_val)


def get_request_budget(state, rate_limit: str, now_ts: float | None = None) -> dict[str, Any]:
    ensure_usage_state(state)
    now_val = now_ts if now_ts is not None else time.time()

    limit, window_seconds = _parse_rate_limit(rate_limit)
    _evict_expired_requests(state, now_val - window_seconds)

    used = min(len(state.message_request_times), limit)
    remaining = max(limit - used, 0)

    reset_in_seconds = 0
    if state.message_request_times and remaining == 0:
        oldest = state.message_request_times[0]
        reset_in_seconds = max(int(window_seconds - (now_val - oldest)), 0)

    return {
        "limit": limit,
        "window_seconds": window_seconds,
        "used": used,
        "remaining": remaining,
        "reset_in_seconds": reset_in_seconds,
    }


def get_usage_summary(state, rate_limit: str, usd_to_myr_rate: float) -> dict[str, Any]:
    ensure_usage_state(state)
    budget = get_request_budget(state, rate_limit)

    return {
        "token_usage": {
            "input_tokens": _as_int(state.usage_totals.get("input_tokens")),
            "output_tokens": _as_int(state.usage_totals.get("output_tokens")),
            "total_tokens": _as_int(state.usage_totals.get("total_tokens")),
            "cost_usd": round(float(state.usage_totals.get("cost_usd") or 0.0), 6),
            "cost_myr": round(float(state.usage_totals.get("cost_myr") or 0.0), 6),
            "usd_to_myr_rate": float(usd_to_myr_rate or 0.0),
            "updated_at": state.usage_totals.get("updated_at"),
        },
        "request_budget": budget,
        "pricing": {
            "input_usd_per_million": TOKEN_PRICING_USD_PER_MILLION["input"],
            "output_usd_per_million": TOKEN_PRICING_USD_PER_MILLION["output"],
        },
    }

"""Chat analysis pipeline helpers.

The pipeline is intentionally split into small steps so each function owns one
decision level and can be tested independently.
"""

from __future__ import annotations

import json
from typing import Any, cast

from src.core import app_config
from src.services import chat_session_service
from src.services import code_executor
from src.services import data_service
from src.services import gemini_service
from src.core.errors import CodeExecutionError, DataTalkError, LLMServiceError


def _build_cache_key(filename: str | None, message: str) -> str:
    return f"{filename}:{message}"


def _copy_cached_result(cached_result: Any) -> dict[str, Any] | None:
    if cached_result is None:
        return None
    if not isinstance(cached_result, dict):
        return None
    copied = cached_result.copy()
    copied["cached"] = True
    return copied


def _ensure_session_history(state, filename: str | None) -> list[dict[str, Any]]:
    """Keep chat history bound to the active session to avoid cross-session bleed."""
    active_session = chat_session_service.ensure_active_session(state, filename=filename)
    history = active_session.get("messages")
    if not isinstance(history, list):
        history = []
    active_session["messages"] = history
    state.chat_history = history
    return history


def _get_or_cache(state, filename: str | None, cache_key: str, producer):
    value = state.get_cached(filename, cache_key)
    if value is None:
        value = producer()
        state.set_cached(filename, cache_key, value)
    return value


def _build_lean_context(df, state, filename: str | None, log_event) -> tuple[str, str]:
    schema_context_lean = _get_or_cache(
        state,
        filename,
        "schema_lean",
        lambda: data_service.get_schema_string(df, max_tokens=2000),
    )

    profile = _get_or_cache(
        state,
        filename,
        "profile",
        lambda: data_service.get_data_profile(df),
    )

    profile_context = data_service.get_profile_string(profile)
    log_event("profile_detected", dataset_type=profile.get("dataset_type"))
    return schema_context_lean, profile_context


def _build_full_schema_context(df, state, filename: str | None) -> str:
    return _get_or_cache(
        state,
        filename,
        "schema_full",
        lambda: data_service.get_schema_string(df, max_tokens=15000),
    )


def _extract_relevant_data_context(
    *,
    message: str,
    schema_context_lean: str,
    df,
    state,
    record_usage,
    log_event,
) -> str | None:
    """Phase 0.5 narrows prompt noise before code generation for better reliability."""
    try:
        log_event("extraction_started")
        extraction_code, usage = gemini_service.generate_data_extraction_code(message, schema_context_lean)
        record_usage(state, usage, "Extraction")
        if not extraction_code:
            return None

        extracted_data = code_executor.execute_extraction_code(extraction_code, df)
        if isinstance(extracted_data, dict) and not extracted_data.get("error"):
            log_event("extraction_succeeded")
            return json.dumps(extracted_data, default=str)

        log_event("extraction_failed")
        return None
    except Exception as err:  # noqa: BLE001 - extraction is best-effort by design.
        log_event("extraction_warning", error=str(err))
        return None


def _run_generated_code_analysis(
    *,
    message: str,
    schema_context_full: str,
    history_capped: list[dict[str, Any]],
    profile_context: str,
    extracted_data_context: str | None,
    df,
    state,
    record_usage,
    log_event,
):
    """Yield phase updates while attempting code-gen, execution, retries, and interpretation."""
    generated_code, usage = gemini_service.generate_analysis_code(
        message,
        schema_context_full,
        history_capped,
        profile_context,
        extracted_data_context,
    )
    record_usage(state, usage, "Code Gen")

    if not generated_code:
        return

    retry_code = None
    max_retries = app_config.MAX_RETRIES

    for attempt in range(max_retries + 1):
        code_to_run = generated_code if attempt == 0 else retry_code
        if not code_to_run:
            return

        attempt_label = "Initial" if attempt == 0 else f"Retry {attempt}/{max_retries}"
        yield ("phase", {"phase": "executing", "message": f"Running analysis ({attempt_label})..."})
        log_event("code_exec_started", attempt=attempt_label, chars=len(code_to_run))

        try:
            exec_result = code_executor.execute_analysis_code(code_to_run, df)
            exec_result["mode"] = "code_execution"
            log_event("code_exec_succeeded", attempt=attempt_label)

            yield ("phase", {"phase": "interpreting", "message": "Interpreting results..."})
            log_event("interpret_started")
            interpretation, usage = gemini_service.interpret_results(
                message,
                schema_context_full,
                exec_result,
                history_capped,
            )
            record_usage(state, usage, "Interpret")

            if interpretation:
                exec_result["text"] = interpretation
                log_event("interpret_succeeded")
            else:
                log_event("interpret_failed")

            yield ("analysis_result", exec_result)
            return
        except CodeExecutionError as err:
            error_message = str(err)
            log_event("code_exec_failed", error=error_message)

            if attempt >= max_retries:
                log_event("retry_exhausted")
                return

            yield ("phase", {"phase": "retrying", "message": f"Fixing code (attempt {attempt + 1})..."})
            log_event("retry_started", attempt=attempt + 1, max_retries=max_retries)

            try:
                retry_code, usage = gemini_service.retry_analysis_code(
                    message,
                    schema_context_full,
                    code_to_run,
                    error_message,
                    profile_context,
                    extracted_data_context,
                )
                record_usage(state, usage, "Retry")
                if retry_code:
                    log_event("retry_code_generated", chars=len(retry_code))
                else:
                    log_event("retry_failed")
                    return
            except LLMServiceError:
                log_event("retry_failed")
                return


def run_analysis_pipeline(
    *,
    message: str,
    filename: str | None,
    user_id: str,
    state,
    skip_cache: bool,
    get_dataframe,
    save_chat_history,
    record_usage,
    log_event,
):
    """Run analysis workflow as an event stream shared by sync and SSE endpoints."""
    try:
        cache_key = _build_cache_key(filename, message)
        if not skip_cache:
            cached = _copy_cached_result(state.query_cache.get(cache_key))
            if cached is not None:
                log_event("chat_cache_hit", user_id=user_id, filename=filename)
                yield ("result", cached)
                return

        history = _ensure_session_history(state, filename)
        history_capped = history[-app_config.CHAT_HISTORY_CAP:] if history else []

        if gemini_service.is_conversational_query(message):
            log_event("conversational_query_detected")
            yield ("phase", {"phase": "thinking", "message": "Thinking..."})
            result = gemini_service.conversational_response(message, history_capped)
            record_usage(state, result.get("usage"), "Conversational")
            result["mode"] = "conversational"
            result["cached"] = False
            
            state.query_cache.set(cache_key, result)
            
            chat_session_service.append_exchange(state, message, result)
            save_chat_history(user_id=user_id, state=state)
            
            yield ("result", result)
            return

        yield ("phase", {"phase": "loading", "message": "Loading dataset..."})
        df = get_dataframe(filename, user_id=user_id, state=state)

        schema_context_lean, profile_context = _build_lean_context(df, state, filename, log_event)

        yield ("phase", {"phase": "extracting", "message": "Extracting relevant data..."})
        extracted_data_context = _extract_relevant_data_context(
            message=message,
            schema_context_lean=schema_context_lean,
            df=df,
            state=state,
            record_usage=record_usage,
            log_event=log_event,
        )

        yield ("phase", {"phase": "generating", "message": "Writing analysis code..."})
        schema_context_full = _build_full_schema_context(df, state, filename)

        result: dict[str, Any] | None = None
        for event_type, payload in _run_generated_code_analysis(
            message=message,
            schema_context_full=schema_context_full,
            history_capped=history_capped,
            profile_context=profile_context,
            extracted_data_context=extracted_data_context,
            df=df,
            state=state,
            record_usage=record_usage,
            log_event=log_event,
        ):
            if event_type == "analysis_result":
                result = cast(dict[str, Any], payload)
                break
            yield (event_type, payload)

        if result is None:
            yield ("phase", {"phase": "fallback", "message": "Using text-based analysis..."})
            log_event("fallback_analysis_started")
            data_context = data_service.get_context_string(df, max_rows=5)
            result = gemini_service.analyse_data(message, data_context, history_capped)
            record_usage(state, result.get("usage"), "Fallback Text Analysis")
            if result.get("error"):
                yield (
                    "error",
                    {
                        "error": True,
                        "text": result.get("text", "AI service encountered an error."),
                        "error_type": "gemini_error",
                    },
                )
                return
            result["mode"] = "text_analysis"

        result["cached"] = False
        state.query_cache.set(cache_key, result)

        chat_session_service.append_exchange(state, message, result)
        save_chat_history(user_id=user_id, state=state)

        yield ("result", result)

    except DataTalkError as err:
        yield (
            "error",
            {
                "error": True,
                "text": err.message,
                "error_type": err.error_type,
                "status_code": err.status_code,
            },
        )
    except Exception as err:  # noqa: BLE001 - final guard for API stability.
        yield (
            "error",
            {
                "error": True,
                "text": f"Error analysing data: {str(err)}",
                "error_type": "analysis_error",
                "status_code": 500,
            },
        )

"""
server.py — Flask API server for Data Talk.

Serves static HTML files and provides REST API endpoints for:
- User authentication (Supabase Auth)
- File upload
- Gemini chat analysis (streaming + non-streaming)
- Dashboard config save/load

All /api/* data routes are protected by @require_auth.
State is per-user via SessionManager.
"""

from dotenv import load_dotenv
load_dotenv()

import os
import re
import json
import time
import logging
import ipaddress
from concurrent.futures import ThreadPoolExecutor
import pandas as pd
from flask import Flask, request, jsonify, send_from_directory, g, Response, stream_with_context
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from src.core import app_config
from src.core.pagination import paginate
from src.core.app_state import SessionManager
from src.services import data_service
from src.services import gemini_service
from src.services import auth_service
from src.services import chat_session_service
from src.services import usage_service
from src.services.auth_service import require_auth
from src.core.errors import DataTalkError, ValidationError, LimitExceededError
from src.services.analysis_pipeline import run_analysis_pipeline
from src.services.dashboard_store import (
    get_session_dashboard,
    load_dashboard_store,
    save_dashboard_store,
)


# ==============================================================
# Flask App Setup
# ==============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = app_config.MAX_CONTENT_LENGTH

cors_origins = app_config.get_allowed_cors_origins()
CORS(app, resources={r"/api/*": {"origins": cors_origins}}, supports_credentials=True)

logger = logging.getLogger("data_talk")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

import atexit

session_mgr = SessionManager()
history_write_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="chat-history")
# Ensure in-flight async history writes complete before process exit to avoid data loss.
atexit.register(history_write_executor.shutdown, wait=True)

def _get_user_id_or_ip():
    """Return user_id if authenticated, else IP address for rate limiting."""
    return getattr(g, "user_id", get_remote_address())

limiter = Limiter(
    key_func=_get_user_id_or_ip,
    app=app,
    default_limits=[],
    storage_uri="memory://"
)

ALLOWED_HTML_FILES = {
    "index.html",
    "dashboard.html",
    "login.html",
    "profile.html",
}
ALLOWED_STATIC_PREFIXES = (
    "assets/",
    "js/",
    "css/",
)
EMPTY_SESSION_FILE_SENTINEL = "__no_active_file__"


# ==============================================================
# Helpers: Logging
# ==============================================================

def _log_event(event, **fields):
    """Emit one-line structured logs for easier filtering."""
    payload = {"event": event, **fields}
    logger.info(json.dumps(payload, default=str))


def _log_token_usage(usage, label="LLM interaction"):
    """Log token usage in a structured format."""
    if not usage:
        return
    _log_event("token_usage",
               label=label,
               input_tokens=usage.get("input_tokens", 0),
               output_tokens=usage.get("output_tokens", 0),
               total_tokens=usage.get("total_tokens", 0))


def _activate_file(state, filename, active_session=None):
    """Keep the active file and active session aligned so route handlers only need one call."""
    state.active_file["filename"] = filename
    if active_session is None:
        active_session = chat_session_service.ensure_active_session(state, filename=filename)
    if filename and not active_session.get("filename"):
        active_session["filename"] = filename
    return active_session


def _get_active_session(state):
    """Resolve the active session once so callers can reuse it for related payloads."""
    return chat_session_service.ensure_active_session(state, filename=state.active_file.get("filename"))


def _record_and_log_usage(state, usage, label="LLM interaction"):
    """Persist token usage to state and emit structured logs."""
    if not usage:
        return
    usage_service.record_token_usage(state, usage, app_config.USD_TO_MYR_RATE)
    _log_token_usage(usage, label)


# ==============================================================
# Helpers: State
# ==============================================================

def _get_user_state():
    """Get the per-user state for the current authenticated request."""
    state = session_mgr.get_state(g.user_id)
    usage_service.ensure_usage_state(state)
    if not getattr(state, "chat_sessions", None):
        chat_session_service.ensure_active_session(
            state,
            filename=state.active_file.get("filename"),
            force_new=True,
        )
    chat_session_service.enforce_session_limit(state, app_config.MAX_CHAT_SESSIONS)
    return state


def _get_dataframe(filename, user_id, state):
    """Get the dataframe from cache or load it from storage."""
    df = state.get_cached(filename, "df")
    if df is not None:
        _log_event("dataframe_cache_hit", user_id=user_id, filename=filename)
        return df

    lock = state.get_file_lock(filename)
    with lock:
        cached_after_lock = state.get_cached(filename, "df")
        if cached_after_lock is not None:
            _log_event("dataframe_cache_hit", user_id=user_id, filename=filename)
            return cached_after_lock

        _log_event("dataframe_cache_miss", user_id=user_id, filename=filename)
        df = data_service.load_file(filename, user_id=user_id)
        state.set_cached(filename, "df", df)
        return df


def _build_chat_session_payload(state):
    """Return active-session context so clients can update UI without extra round-trips."""
    chat_session_service.enforce_session_limit(state, app_config.MAX_CHAT_SESSIONS)
    active_session = _get_active_session(state)
    history = chat_session_service.get_active_messages(state, active_session=active_session)
    history_window = history[-app_config.DEFAULT_PAGE_SIZE:]
    return {
        "active_session_id": state.active_session_id,
        "active_filename": active_session.get("filename") or state.active_file.get("filename"),
        "sessions": chat_session_service.list_session_summaries(state),
        "history": list(reversed(history_window)),
        "max_chat_sessions": app_config.MAX_CHAT_SESSIONS,
        "max_upload_mb": app_config.MAX_UPLOAD_MB,
    }


# ==============================================================
# Helpers: Chat
# ==============================================================

def _build_chat_history_snapshot(state) -> tuple[str, dict]:
    """Capture the exact payload to persist before any async handoff occurs."""
    active_session = _get_active_session(state)
    payload = chat_session_service.build_persisted_payload(state)
    active_filename = str(active_session.get("filename") or state.active_file.get("filename") or "").strip()
    persisted_filename = active_filename if active_filename else EMPTY_SESSION_FILE_SENTINEL
    return persisted_filename, payload


def _write_chat_history_snapshot(user_id: str, persisted_filename: str, payload: dict) -> None:
    """Persist a prebuilt chat-history snapshot to Supabase."""
    try:
        sb_service = auth_service.get_supabase_service()
        sb_service.table("chat_sessions").upsert({
            "user_id": user_id,
            "filename": persisted_filename,
            "history": payload,
            "updated_at": "now()"
        }, on_conflict="user_id, filename").execute()
    except Exception as e:
        logger.error("Chat history save failed to Supabase: %s", e)


def _save_chat_history(user_id, state):
    """Persist chat history synchronously (used for chat responses and strict consistency paths)."""
    try:
        persisted_filename, payload = _build_chat_history_snapshot(state)
        _write_chat_history_snapshot(user_id, persisted_filename, payload)
    except Exception as e:
        logger.error("Chat history save failed to Supabase: %s", e)


def _save_chat_history_async(user_id, state):
    """Persist chat history in the background to keep UI-facing routes responsive."""
    try:
        persisted_filename, payload = _build_chat_history_snapshot(state)
        history_write_executor.submit(
            _write_chat_history_snapshot,
            user_id,
            persisted_filename,
            payload,
        )
    except Exception as e:
        logger.error("Async chat history save scheduling failed: %s", e)


def _load_chat_history_for_user(user_id):
    """Load chat history from Supabase for a specific user."""
    state = session_mgr.get_state(user_id)
    usage_service.ensure_usage_state(state)
    try:
        sb_service = auth_service.get_supabase_service()
        # Schema contract: one row per user — all sessions are serialised into
        # the `history` JSON column. If the schema ever migrates to per-session
        # rows, this limit(1) must be removed and the loop below updated.
        result = sb_service.table("chat_sessions") \
            .select("filename, history") \
            .eq("user_id", user_id) \
            .order("updated_at", desc=True) \
            .limit(1).execute()

        if result.data:
            session = result.data[0]
            restored_filename_raw = str(session.get("filename") or "").strip()
            restored_filename = (
                None
                if not restored_filename_raw or restored_filename_raw == EMPTY_SESSION_FILE_SENTINEL
                else restored_filename_raw
            )
            state.active_file["filename"] = restored_filename
            chat_session_service.restore_from_persisted_payload(
                state,
                session.get("history", []),
                user_id=user_id,
                fallback_filename=restored_filename,
            )
            _log_event("active_file_rehydrated", user_id=user_id, filename=restored_filename)
        else:
            chat_session_service.restore_from_persisted_payload(
                state,
                [],
                user_id=user_id,
                fallback_filename=state.active_file.get("filename"),
            )
        chat_session_service.ensure_active_session(
            state,
            filename=state.active_file.get("filename"),
        )
        chat_session_service.enforce_session_limit(state, app_config.MAX_CHAT_SESSIONS)
    except Exception as e:
        logger.error("Chat history load failed from Supabase: %s", e)


def _error_response(message, status_code=500, error_type="server_error"):
    """Return a standardised JSON error with proper HTTP status code."""
    return jsonify({
        "error": True,
        "error_type": error_type,
        "text": message,
        "chart": None,
        "table": None,
        "stats": None,
        "followup": [],
    }), status_code


def _sse_event(event, data):
    """Format a single SSE event string."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _auth_cookie_kwargs(max_age_seconds: int) -> dict[str, object]:
    """Build cookie attributes in one place to keep auth cookie behaviour consistent."""
    kwargs: dict[str, object] = {
        "httponly": True,
        "secure": app_config.AUTH_COOKIE_SECURE,
        "samesite": app_config.AUTH_COOKIE_SAMESITE,
        "path": app_config.AUTH_COOKIE_PATH,
        "max_age": max_age_seconds,
    }
    if app_config.AUTH_COOKIE_DOMAIN:
        kwargs["domain"] = app_config.AUTH_COOKIE_DOMAIN
    return kwargs


def _set_auth_cookies(response, access_token: str | None, refresh_token: str | None) -> None:
    """Write access/refresh tokens into secure httpOnly cookies."""
    if access_token:
        response.set_cookie(
            app_config.AUTH_ACCESS_COOKIE_NAME,
            access_token,
            **_auth_cookie_kwargs(app_config.AUTH_ACCESS_COOKIE_MAX_AGE_SECONDS),
        )
    if refresh_token:
        response.set_cookie(
            app_config.AUTH_REFRESH_COOKIE_NAME,
            refresh_token,
            **_auth_cookie_kwargs(app_config.AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS),
        )


def _clear_auth_cookies(response) -> None:
    """Delete auth cookies during logout and stale-session cleanup."""
    delete_kwargs = {
        "path": app_config.AUTH_COOKIE_PATH,
    }
    if app_config.AUTH_COOKIE_DOMAIN:
        delete_kwargs["domain"] = app_config.AUTH_COOKIE_DOMAIN

    response.delete_cookie(app_config.AUTH_ACCESS_COOKIE_NAME, **delete_kwargs)
    response.delete_cookie(app_config.AUTH_REFRESH_COOKIE_NAME, **delete_kwargs)


@app.before_request
def _mark_request_start_time() -> None:
    """Capture request start timestamps for slow-path diagnostics."""
    g._request_started_at = time.perf_counter()


@app.after_request
def _log_slow_requests(response):
    """Log only slow API requests so noisy access logs still remain readable."""
    started = getattr(g, "_request_started_at", None)
    if started is None:
        return response

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    threshold_ms = max(1, int(app_config.SLOW_REQUEST_LOG_THRESHOLD_MS or 1))
    if request.path.startswith("/api/") and elapsed_ms >= threshold_ms:
        _log_event(
            "slow_request",
            method=request.method,
            path=request.path,
            status=response.status_code,
            elapsed_ms=round(elapsed_ms, 2),
        )
    return response


# ==============================================================
# Routes: Static File Serving
# ==============================================================

@app.errorhandler(DataTalkError)
def handle_data_talk_error(e):
    """Global error handler for DataTalkError exceptions."""
    return _error_response(e.message, status_code=e.status_code, error_type=e.error_type)

@app.errorhandler(429)
def ratelimit_handler(e):
    """Global error handler for rate limit exceptions."""
    return _error_response(f"Rate limit exceeded: {e.description}", status_code=429, error_type="rate_limit_exceeded")

@app.route("/")
def serve_index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    """Serve static files (HTML, CSS, JS, assets)."""
    normalized = filename.replace("\\", "/")
    if ".." in normalized:
        return jsonify({"error": "Invalid static path"}), 400

    if normalized in ALLOWED_HTML_FILES:
        return send_from_directory(PUBLIC_DIR, normalized)

    if not normalized.startswith(ALLOWED_STATIC_PREFIXES):
        return jsonify({"error": "Static file not found"}), 404

    return send_from_directory(BASE_DIR, filename)


@app.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(_err):
    """Return a clear error message when upload exceeds configured max size."""
    return jsonify({
        "error": f"File is too large. Max upload size is {app_config.MAX_UPLOAD_MB}MB."
    }), 413


# ==============================================================
# Routes: Authentication
# ==============================================================

@app.route("/api/auth/signup", methods=["POST"])
def api_signup():
    """Register a new user."""
    data = request.get_json()
    if not data:
        raise ValidationError("No data provided")

    email = data.get("email", "").strip()
    password = data.get("password", "")
    display_name = data.get("display_name", "").strip()

    if not email or not password:
        raise ValidationError("Email and password are required")
    if len(password) < 8:
        raise ValidationError("Password must be at least 8 characters")
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", password):
        raise ValidationError("Password must contain at least one special character")

    result = auth_service.signup(email, password, display_name)

    response = jsonify({
        "success": True,
        "user": result.get("user"),
        "email_confirmation_required": not bool(result.get("access_token")),
    })
    _set_auth_cookies(response, result.get("access_token"), result.get("refresh_token"))
    return response


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    """Authenticate a user and return tokens."""
    data = request.get_json()
    if not data:
        raise ValidationError("No data provided")

    email = data.get("email", "").strip()
    password = data.get("password", "")

    if not email or not password:
        raise ValidationError("Email and password are required")

    result = auth_service.login(email, password)

    user_id = result["user"]["id"]
    _load_chat_history_for_user(user_id)
    _log_event("user_login", user_id=user_id, email=email)

    response = jsonify({
        "success": True,
        "user": result["user"],
    })
    _set_auth_cookies(response, result.get("access_token"), result.get("refresh_token"))
    return response


@app.route("/api/auth/reset-password", methods=["POST"])
def api_reset_password():
    """Request a password reset email."""
    data = request.get_json()
    email = data.get("email", "").strip() if data else ""
    if not email:
        raise ValidationError("Email is required")
        
    redirect_to = str(request.url_root).rstrip("/") + "/login.html"
    auth_service.reset_password(email, redirect_to=redirect_to)
    return jsonify({"success": True, "message": "Password reset email sent."})


@app.route("/api/auth/update-password", methods=["POST"])
def api_update_password():
    """Update password using a recovery token."""
    data = request.get_json()
    if not data:
        raise ValidationError("No data provided")
        
    token = data.get("access_token", "")
    new_password = data.get("password", "")
    
    if not token or not new_password:
        raise ValidationError("Token and new password are required")
        
    auth_service.update_password(token, new_password)
    return jsonify({"success": True, "message": "Password updated successfully."})


@app.route("/api/auth/logout", methods=["POST"])
@require_auth
def api_logout():
    """Sign out the current user."""
    token = getattr(g, "access_token", "")
    if token:
        auth_service.logout(token)
    session_mgr.remove_state(g.user_id)
    _log_event("user_logout", user_id=g.user_id)
    response = jsonify({"success": True})
    _clear_auth_cookies(response)
    return response


@app.route("/api/auth/session", methods=["GET"])
@require_auth
def api_session():
    """Validate the current session and return user info."""
    state = _get_user_state()
    if not state.chat_sessions and not state.active_file.get("filename"):
        _load_chat_history_for_user(g.user_id)

    profile = auth_service.get_profile(g.user_id)
    display_name = g.user_email.split("@")[0]
    avatar_initials = display_name[:2].upper()

    if profile:
        display_name = profile.get("display_name", display_name)
        avatar_initials = profile.get("avatar_initials", avatar_initials)

    return jsonify({
        "valid": True,
        "user": {
            "id": g.user_id,
            "email": g.user_email,
            "display_name": display_name,
            "avatar_initials": avatar_initials,
        }
    })


@app.route("/api/profile", methods=["POST"])
@require_auth
def update_profile():
    """Update account profile settings."""
    data = request.get_json(silent=True) or {}
    display_name = (data.get("display_name") or "").strip()
    if not display_name:
        raise ValidationError("Display name is required")

    profile = auth_service.update_profile(g.user_id, display_name)
    return jsonify({"success": True, "profile": profile})


# ==============================================================
# Routes: File Upload & Dataset Access
# ==============================================================

@app.route("/api/upload", methods=["POST"])
@require_auth
def upload_file():
    """Upload a CSV/Excel file. Returns filename, column info, row count, preview data."""
    if "file" not in request.files:
        raise ValidationError("No file provided")

    file = request.files["file"]
    if file.filename == "":
        raise ValidationError("No file selected")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".csv", ".xlsx", ".xls"):
        raise ValidationError(f"Unsupported file type: {ext}. Use CSV or Excel.")

    filename, _ = data_service.save_uploaded_file(file, user_id=g.user_id)

    state = _get_user_state()
    # Parse from the uploaded stream we already have to avoid a second storage download.
    df = data_service.load_uploaded_dataframe(file, filename)
    summary = data_service.get_summary(df, include_describe=False)

    state.query_cache.clear()
    state.clear_file_cache()
    state.set_cached(filename, "df", df)
    _activate_file(state, filename)
    chat_session_service.enforce_session_limit(state, app_config.MAX_CHAT_SESSIONS)
    _save_chat_history_async(user_id=g.user_id, state=state)

    _log_event("file_uploaded", user_id=g.user_id, filename=filename,
                rows=summary["shape"]["rows"], cols=summary["shape"]["columns"])

    return jsonify({
        "success": True,
        "filename": filename,
        "path": filename,
        "summary": summary,
    })


@app.route("/api/files", methods=["GET"])
@require_auth
def list_uploaded_files():
    """List files uploaded by the authenticated user."""
    files = data_service.list_user_files(user_id=g.user_id)
    return jsonify({"files": files})


@app.route("/api/data-summary/<path:filename>", methods=["GET"])
@require_auth
def data_summary(filename):
    """Get summary stats for a specific uploaded file."""
    state = _get_user_state()
    _activate_file(state, filename)
    df = _get_dataframe(filename, user_id=g.user_id, state=state)
    summary = data_service.get_summary(df, include_describe=False)
    return jsonify({"filename": filename, "summary": summary})


@app.route("/api/data/<path:filename>", methods=["GET"])
@require_auth
def get_full_data(filename):
    """Get the full dataset for the data connector."""
    state = _get_user_state()
    _activate_file(state, filename)
    df = _get_dataframe(filename, user_id=g.user_id, state=state)
    data = [df.columns.tolist()] + df.fillna("").values.tolist()
    return jsonify({"filename": filename, "data": data})


@app.route("/api/data/<path:filename>", methods=["PUT"])
@require_auth
def save_full_data(filename):
    """Persist edited dataset content and refresh in-memory analysis caches."""
    body = request.get_json(silent=True) or {}
    grid_data = body.get("data")

    if not isinstance(grid_data, list) or len(grid_data) == 0:
        raise ValidationError("Dataset payload must include at least one row.")
    if not isinstance(grid_data[0], list):
        raise ValidationError("Dataset payload has an invalid header row.")

    header_row = grid_data[0]
    headers = []
    for idx, value in enumerate(header_row):
        label = str(value or "").strip()
        headers.append(label or f"column_{idx + 1}")

    rows = []
    for row in grid_data[1:]:
        if not isinstance(row, list):
            continue
        normalized = [row[i] if i < len(row) else "" for i in range(len(headers))]
        rows.append(normalized)

    # Handsontable appends trailing empty rows during edits; strip them to
    # prevent unintentional row count inflation on save.
    while rows and all(cell is None or str(cell).strip() == "" for cell in rows[-1]):
        rows.pop()

    df = pd.DataFrame(rows, columns=headers)
    data_service.save_dataframe(filename, df, user_id=g.user_id)

    state = _get_user_state()
    state.query_cache.clear()
    state.clear_file_cache()
    state.set_cached(filename, "df", df)
    _activate_file(state, filename)

    summary = data_service.get_summary(df, include_describe=False)
    _save_chat_history_async(user_id=g.user_id, state=state)

    return jsonify({
        "success": True,
        "filename": filename,
        "summary": summary,
        "saved_at": chat_session_service.now_iso(),
    })


@app.route("/api/suggest-questions", methods=["GET"])
@require_auth
def suggest_questions():
    """Ask Gemini to suggest 4 smart questions based on the active dataset."""
    state = _get_user_state()
    filename = state.active_file.get("filename")
    if not filename:
        return jsonify({"questions": []})

    try:
        df = _get_dataframe(filename, user_id=g.user_id, state=state)
        cols_info = ", ".join([f"{c} ({df[c].dtype})" for c in df.columns[:15]])

        prompt = f"""Given a dataset with these columns: {cols_info}
The dataset has {len(df)} rows.

Suggest exactly 4 short, specific data analysis questions a user might ask about this data.
Each question should be different in type (e.g. one summary, one comparison, one chart, one trend/pattern).
Keep each question under 8 words. Add a relevant emoji at the start.

Return ONLY a JSON array of 4 strings, no other text. Example:
["📊 Show sales by region", "📈 Monthly revenue trend", "🔍 Top 5 customers by value", "📝 Average order size by category"]"""

        response = gemini_service.client.models.generate_content(
            model=gemini_service.MODEL_ID,
            contents=prompt,
        )
        usage_dict = gemini_service._extract_usage_dict(response)
        _record_and_log_usage(state, usage_dict, "Suggest Questions")

        text_raw = getattr(response, "text", "")
        text = text_raw.strip() if isinstance(text_raw, str) else ""
        text = re.sub(r'^```(?:json)?\s*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)
        questions = json.loads(text)

        if isinstance(questions, list) and len(questions) > 0:
            return jsonify({"questions": questions[:4]})
        return jsonify({"questions": []})

    except Exception as e:
        _log_event("suggest_questions_error", error=str(e))
        return jsonify({"questions": []})


# ==============================================================
# Routes: Chat
# ==============================================================

def _parse_chat_request():
    """Parse and validate a chat request. Returns (message, filename, user_id, state, skip_cache) or raises DataTalkError."""
    data = request.get_json()
    if not data or "message" not in data:
        raise DataTalkError("No message provided", status_code=400, error_type="validation_error")

    user_id = g.user_id
    state = _get_user_state()
    requested_session_id = (data.get("session_id") or "").strip()
    if requested_session_id:
        activated = chat_session_service.set_active_session(state, requested_session_id)
        if not activated:
            raise DataTalkError("Chat session not found", status_code=404, error_type="session_not_found")

    message = data["message"]
    filename = data.get("filename") or state.active_file.get("filename")
    if not filename:
        filename = chat_session_service.ensure_active_session(state, filename=filename).get("filename")
    if filename:
        _activate_file(state, filename)

    skip_cache = data.get("skip_cache", False)

    if not filename:
        if not gemini_service.is_conversational_query(message):
            raise DataTalkError(
                "Please upload a dataset first! Go to the **Data Connector** tab and upload a CSV or Excel file.",
                status_code=400,
                error_type="no_file"
            )

    return message, filename, user_id, state, skip_cache


@app.route("/api/chat", methods=["POST"])
@require_auth
@limiter.limit(app_config.RATE_LIMIT)
def chat():
    """
    Non-streaming chat endpoint.
    Body: { "message": "...", "filename": "..." (optional), "skip_cache": false }
    Returns: { "text": "...", "chart": {...} or null, "cached": bool }
    """
    message, filename, user_id, state, skip_cache = _parse_chat_request()
    usage_service.record_message_request(state, app_config.RATE_LIMIT)

    for event_type, payload in run_analysis_pipeline(
        message=message,
        filename=filename,
        user_id=user_id,
        state=state,
        skip_cache=skip_cache,
        get_dataframe=_get_dataframe,
        save_chat_history=_save_chat_history,
        record_usage=_record_and_log_usage,
        log_event=_log_event,
    ):
        if event_type == "result":
            payload["session_id"] = state.active_session_id or ""
            return jsonify(payload)
        if event_type == "error":
            raw_status = payload.get("status_code", 500)
            status = raw_status if isinstance(raw_status, int) else 500
            return _error_response(payload["text"], status_code=status, error_type=payload.get("error_type", "server_error"))

    # Defensive guard — pipeline always yields a result or error, so this is unreachable
    return _error_response("Unexpected pipeline termination.", status_code=500)


@app.route("/api/chat/stream", methods=["POST"])
@require_auth
@limiter.limit(app_config.RATE_LIMIT)
def chat_stream():
    """
    SSE streaming chat endpoint. Yields real-time phase updates.
    Body: { "message": "...", "filename": "..." (optional), "skip_cache": false }
    Events: phase, result, error, done
    """
    message, filename, user_id, state, skip_cache = _parse_chat_request()
    usage_service.record_message_request(state, app_config.RATE_LIMIT)

    def generate():
        for event_type, payload in run_analysis_pipeline(
            message=message,
            filename=filename,
            user_id=user_id,
            state=state,
            skip_cache=skip_cache,
            get_dataframe=_get_dataframe,
            save_chat_history=_save_chat_history,
            record_usage=_record_and_log_usage,
            log_event=_log_event,
        ):
            if event_type == "result":
                payload["session_id"] = state.active_session_id or ""
            yield _sse_event(event_type, payload)
        yield _sse_event("done", {})

    return Response(stream_with_context(generate()), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@app.route("/api/chat/history", methods=["GET"])
@require_auth
def get_chat_history():
    """Get the current chat history with pagination.

    Query params: page (default 1), per_page (default 50).
    Returns most recent messages first; page 1 = latest messages.
    """
    state = _get_user_state()
    active_session = _get_active_session(state)
    history = chat_session_service.get_active_messages(state, active_session=active_session)

    if not history:
        _load_chat_history_for_user(g.user_id)
        state = _get_user_state()
        active_session = _get_active_session(state)
        history = chat_session_service.get_active_messages(state, active_session=active_session)

    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", app_config.DEFAULT_PAGE_SIZE, type=int)

    reversed_history = list(reversed(history))
    result = paginate(reversed_history, page=page, per_page=per_page, max_page_size=app_config.MAX_PAGE_SIZE)

    return jsonify({
        "session_id": state.active_session_id,
        "history": result["items"],
        "page": result["page"],
        "per_page": result["per_page"],
        "total": result["total"],
        "total_pages": result["total_pages"],
    })


@app.route("/api/chat/sessions", methods=["GET"])
@require_auth
def list_chat_sessions():
    """List all saved chat sessions for the current user."""
    state = _get_user_state()
    should_rehydrate = not state.chat_sessions
    if not should_rehydrate and len(state.chat_sessions) == 1:
        only = state.chat_sessions[0]
        only_messages = only.get("messages") if isinstance(only, dict) else []
        only_title = str(only.get("title") or "").strip() if isinstance(only, dict) else ""
        if not only_messages and only_title in {"", "New Conversation"}:
            should_rehydrate = True

    if should_rehydrate:
        _load_chat_history_for_user(g.user_id)
        state = _get_user_state()

    payload = _build_chat_session_payload(state)
    return jsonify(payload)


@app.route("/api/chat/sessions/new", methods=["POST"])
@require_auth
def create_chat_session():
    """Create a new chat session and set it active."""
    state = _get_user_state()
    if len(state.chat_sessions) >= app_config.MAX_CHAT_SESSIONS:
        raise LimitExceededError(
            f"You can keep up to {app_config.MAX_CHAT_SESSIONS} conversations. Delete one before creating a new conversation."
        )

    data = request.get_json(silent=True) or {}
    requested_filename = data.get("filename")
    if isinstance(requested_filename, str):
        requested_filename = requested_filename.strip() or None
    else:
        requested_filename = None

    if requested_filename is None and data.get("use_active_file"):
        requested_filename = state.active_file.get("filename")

    title = (data.get("title") or "").strip()[:80] or None

    session = chat_session_service.create_session(filename=requested_filename, title=title)
    state.chat_sessions.insert(0, session)
    state.active_session_id = session["id"]
    state.chat_history = session["messages"]
    _activate_file(state, requested_filename, session)
    chat_session_service.enforce_session_limit(state, app_config.MAX_CHAT_SESSIONS)

    _save_chat_history_async(user_id=g.user_id, state=state)
    payload = _build_chat_session_payload(state)
    return jsonify({"success": True, "session": session, **payload})


@app.route("/api/chat/sessions/<session_id>/activate", methods=["POST"])
@require_auth
def activate_chat_session(session_id):
    """Activate an existing chat session."""
    state = _get_user_state()
    session = chat_session_service.set_active_session(state, session_id)
    if not session:
        return _error_response("Chat session not found", status_code=404, error_type="session_not_found")

    _activate_file(state, session.get("filename"), session)

    payload = _build_chat_session_payload(state)
    return jsonify({"success": True, **payload})


@app.route("/api/chat/sessions/<session_id>", methods=["DELETE"])
@require_auth
def delete_chat_session(session_id):
    """Delete one chat session while preserving others."""
    state = _get_user_state()
    deleted = chat_session_service.delete_session(state, session_id)
    if not deleted:
        return _error_response("Chat session not found", status_code=404, error_type="session_not_found")

    if state.active_session_id:
        active = chat_session_service.set_active_session(state, state.active_session_id)
        _activate_file(state, active.get("filename") if active else None, active)
    else:
        _activate_file(state, None)

    _save_chat_history_async(user_id=g.user_id, state=state)
    payload = _build_chat_session_payload(state)
    return jsonify({"success": True, **payload})


@app.route("/api/usage/summary", methods=["GET"])
@require_auth
def get_usage_summary():
    """Return token/cost totals and remaining request budget for sidebar indicators."""
    state = _get_user_state()
    return jsonify(usage_service.get_usage_summary(state, app_config.RATE_LIMIT, app_config.USD_TO_MYR_RATE))


@app.route("/api/chat/clear", methods=["POST"])
@require_auth
def clear_chat():
    """Clear chat history and reset active file."""
    state = _get_user_state()
    state.chat_history = []
    state.chat_sessions = []
    state.active_session_id = None
    # Delegate zero-state initialisation to the service layer so both places
    # stay in sync if the usage_totals schema ever gains new fields.
    state.usage_totals = None  # type: ignore[assignment]  # forces ensure_usage_state to reinitialise
    usage_service.ensure_usage_state(state)
    state.message_request_times.clear()
    state.query_cache.clear()
    state.active_file["filename"] = None
    state.clear_file_cache()
    state.dashboard_store_cache = None
    state.dashboard_store_cached_at = None
    try:
        sb_service = auth_service.get_supabase_service()
    except Exception as e:
        logger.error("Supabase client init failed during chat clear: %s", e)
    else:
        # Keep dashboard visuals aligned with clear-chat behaviour.
        for table_name, error_message in (
            ("chat_sessions", "Chat history clear failed from Supabase: %s"),
            ("dashboard_configs", "Dashboard clear failed from Supabase during chat clear: %s"),
        ):
            try:
                sb_service.table(table_name).delete().eq("user_id", g.user_id).execute()
            except Exception as e:
                logger.error(error_message, e)

    return jsonify({"success": True})


# ==============================================================
# Routes: Dashboard
# ==============================================================

@app.route("/api/dashboard", methods=["GET"])
@require_auth
def get_dashboard():
    """Get the saved dashboard configuration for the active conversation session."""
    state = _get_user_state()
    try:
        session_id = chat_session_service.resolve_requested_session_id(state, request_args=request.args)
        config = load_dashboard_store(g.user_id, session_id, state=state)
        session_config = get_session_dashboard(config, session_id)
        return jsonify({
            "session_id": session_id,
            "charts": session_config.get("charts", []),
            "cards": session_config.get("cards", []),
        })
    except ValidationError:
        raise
    except Exception as e:
        logger.error("Dashboard fetch failed: %s", e)
        return jsonify({"session_id": state.active_session_id, "charts": [], "cards": []})


@app.route("/api/dashboard", methods=["POST"])
@require_auth
def save_dashboard():
    """Save dashboard configuration to Supabase for one session."""
    data = request.get_json(silent=True)
    if not data:
        raise ValidationError("No data provided")

    charts = data.get("charts", [])
    cards = data.get("cards", [])
    if not isinstance(charts, list) or not isinstance(cards, list):
        raise ValidationError("Invalid dashboard payload")

    state = _get_user_state()
    session_id = chat_session_service.resolve_requested_session_id(state, request_data=data)

    try:
        config = load_dashboard_store(g.user_id, session_id, state=state)
        config.setdefault("sessions", {})[session_id] = {
            "charts": charts,
            "cards": cards,
        }
        save_dashboard_store(g.user_id, config, state=state)
        return jsonify({"success": True, "session_id": session_id})
    except Exception as e:
        logger.error("Dashboard save failed to Supabase: %s", e)
        raise DataTalkError(str(e))


@app.route("/api/dashboard/pin", methods=["POST"])
@require_auth
def pin_chart():
    """Pin a single chart to the dashboard for the active session."""
    data = request.get_json(silent=True)
    if not data or "chart" not in data:
        return jsonify({"error": "No chart data provided"}), 400

    state = _get_user_state()
    session_id = chat_session_service.resolve_requested_session_id(state, request_data=data)

    try:
        config = load_dashboard_store(g.user_id, session_id, state=state)
        session_config = get_session_dashboard(config, session_id)
        charts_list = session_config.get("charts", [])
        if not isinstance(charts_list, list):
            charts_list = []

        new_chart = {
            "id": f"chart_{int(time.time() * 1000)}",
            "title": data.get("title", "Untitled Chart"),
            "chart": data["chart"],
            "position": len(charts_list),
            "colSpan": 1
        }
        charts_list.append(new_chart)
        session_config["charts"] = charts_list
        config["sessions"][session_id] = session_config

        save_dashboard_store(g.user_id, config, state=state)

        return jsonify({
            "success": True,
            "chart_id": new_chart["id"],
            "session_id": session_id,
            "chart": new_chart,
        })

    except ValidationError:
        raise
    except Exception as e:
        logger.error("Chart pin failed: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/remove/<chart_id>", methods=["DELETE"])
@require_auth
def remove_chart(chart_id):
    """Remove a chart from the active session dashboard."""
    state = _get_user_state()
    try:
        session_id = chat_session_service.resolve_requested_session_id(state, request_args=request.args)
        config = load_dashboard_store(g.user_id, session_id, state=state)
        session_config = get_session_dashboard(config, session_id)
        session_config["charts"] = [c for c in session_config.get("charts", []) if c.get("id") != chart_id]
        config["sessions"][session_id] = session_config

        save_dashboard_store(g.user_id, config, state=state)

        return jsonify({"success": True, "session_id": session_id})

    except ValidationError:
        raise
    except Exception as e:
        logger.error("Chart removal failed: %s", e)
        return jsonify({"error": str(e)}), 500


from src.core.value_utils import to_native

@app.route("/api/dashboard/card-data", methods=["POST"])
@require_auth
def card_data():
    """Compute an aggregation value for a KPI card."""
    data = request.get_json()
    if not data or "column" not in data:
        return jsonify({"error": "Missing column parameter"}), 400

    column = data["column"]
    aggregation = data.get("aggregation", "count")

    state = _get_user_state()
    # Resolve the intended session (allowing it to come from payload)
    session_id = chat_session_service.resolve_requested_session_id(state, request_data=data)
    if session_id:
        chat_session_service.set_active_session(state, session_id)
        
    filename = state.active_file.get("filename")
    if not filename:
        return jsonify({"error": "No active file"}), 400

    try:
        df = _get_dataframe(filename, user_id=g.user_id, state=state)

        if column not in df.columns:
            return jsonify({"error": f"Column '{column}' not found"}), 400

        col = df[column]
        if aggregation == "count":
            value = int(col.nunique())
        elif aggregation == "total":
            value = len(df)
        elif aggregation == "sum":
            value = float(col.sum()) if col.dtype.kind in ("i", "f") else str(col.sum())
        elif aggregation == "avg":
            value = float(col.mean()) if col.dtype.kind in ("i", "f") else None
        elif aggregation == "min":
            value = float(col.min()) if col.dtype.kind in ("i", "f") else str(col.min())
        elif aggregation == "max":
            value = float(col.max()) if col.dtype.kind in ("i", "f") else str(col.max())
        elif aggregation == "median":
            value = float(col.median()) if col.dtype.kind in ("i", "f") else None
        elif aggregation == "unique":
            value = int(col.nunique())
        else:
            value = int(col.nunique())

        safe_value = to_native(value)
        return jsonify({"success": True, "value": safe_value})
    except Exception as e:
        logger.error("Card data computation failed: %s", e)
        return jsonify({"error": str(e)}), 500


# ==============================================================
# Server Startup
# ==============================================================

def _generate_self_signed_cert():
    """Generate a self-signed SSL certificate for local HTTPS development."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import datetime

    cert_path = os.path.join(BASE_DIR, app_config.SSL_CERT_PATH)
    key_path = os.path.join(BASE_DIR, app_config.SSL_KEY_PATH)

    if os.path.exists(cert_path) and os.path.exists(key_path):
        return cert_path, key_path

    os.makedirs(os.path.dirname(cert_path), exist_ok=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Data Talk Dev"),
    ])

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
        .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))

    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    logger.info("Generated self-signed SSL certificate at %s", cert_path)
    return cert_path, key_path


if __name__ == "__main__":

    ssl_context = None
    protocol = "http"
    if app_config.HTTPS_ENABLED:
        cert_path, key_path = _generate_self_signed_cert()
        ssl_context = (cert_path, key_path)
        protocol = "https"

    _log_event("server_start", port=app_config.PORT, debug=app_config.DEBUG,
               protocol=protocol)
    app.run(debug=app_config.DEBUG, port=app_config.PORT, ssl_context=ssl_context)

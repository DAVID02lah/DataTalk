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
from flask import Flask, request, jsonify, send_from_directory, g, Response, stream_with_context
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

import app_config
from app_state import SessionManager
import data_service
import gemini_service
import auth_service
import chat_session_service
import usage_service
from auth_service import require_auth
from errors import DataTalkError, DatasetNotFoundError, ValidationError
from services.analysis_pipeline import run_analysis_pipeline
from services.dashboard_store import (
    get_session_dashboard,
    load_dashboard_store,
    resolve_requested_session_id,
    save_dashboard_store,
)


# ==============================================================
# Flask App Setup
# ==============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = app_config.MAX_CONTENT_LENGTH

cors_origins = app_config.get_allowed_cors_origins()
CORS(app, resources={r"/api/*": {"origins": cors_origins}})

logger = logging.getLogger("data_talk")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

session_mgr = SessionManager()

def _get_user_id_or_ip():
    """Return user_id if authenticated, else IP address for rate limiting."""
    return getattr(g, "user_id", get_remote_address())

limiter = Limiter(
    key_func=_get_user_id_or_ip,
    app=app,
    default_limits=[],
    storage_uri="memory://"
)

ALLOWED_STATIC_FILES = {
    "index.html",
    "dashboard.html",
    "login.html",
    "profile.html",
    "styles.css",
    "dashboard.css",
}
ALLOWED_STATIC_PREFIXES = (
    "assets/",
    "js/",
    "css/",
)


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
    return state


def _get_dataframe(filename, user_id, state):
    """Get the dataframe from cache or load it from storage."""
    df = state.get_cached(filename, "df")
    if df is not None:
        _log_event("dataframe_cache_hit", user_id=user_id, filename=filename)
        return df

    _log_event("dataframe_cache_miss", user_id=user_id, filename=filename)
    df = data_service.load_file(filename, user_id=user_id)
    state.set_cached(filename, "df", df)
    return df


def _paginate(items, page=1, per_page=app_config.DEFAULT_PAGE_SIZE):
    """Apply offset/limit pagination to a list and return paginated result with metadata."""
    total = len(items)
    per_page = max(1, min(per_page, app_config.MAX_PAGE_SIZE))
    total_pages = max(1, -(-total // per_page))
    page = max(1, min(page, total_pages))
    start = (page - 1) * per_page
    return {
        "items": items[start:start + per_page],
        "page": page,
        "per_page": per_page,
        "total": total,
        "total_pages": total_pages,
    }


# ==============================================================
# Helpers: Chat
# ==============================================================

def _save_chat_history(user_id, state):
    """Persist chat history to Supabase for the given user."""
    try:
        payload = chat_session_service.build_persisted_payload(state)
        active_session = chat_session_service.ensure_active_session(
            state,
            filename=state.active_file.get("filename"),
        )
        sb_service = auth_service.get_supabase_service()
        sb_service.table("chat_sessions").upsert({
            "user_id": user_id,
            "filename": active_session.get("filename") or state.active_file.get("filename"),
            "history": payload,
            "updated_at": "now()"
        }, on_conflict="user_id, filename").execute()
    except Exception as e:
        logger.error("Chat history save failed to Supabase: %s", e)


def _load_chat_history_for_user(user_id):
    """Load chat history from Supabase for a specific user."""
    state = session_mgr.get_state(user_id)
    usage_service.ensure_usage_state(state)
    try:
        sb_service = auth_service.get_supabase_service()
        result = sb_service.table("chat_sessions") \
            .select("filename, history") \
            .eq("user_id", user_id) \
            .order("updated_at", desc=True) \
            .limit(1).execute()

        if result.data:
            session = result.data[0]
            state.active_file["filename"] = session.get("filename")
            chat_session_service.restore_from_persisted_payload(
                state,
                session.get("history", []),
                user_id=user_id,
                fallback_filename=session.get("filename"),
            )
            _log_event("active_file_rehydrated", user_id=user_id, filename=session.get("filename"))
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
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:filename>")
def serve_static(filename):
    """Serve static files (HTML, CSS, JS, assets)."""
    normalized = filename.replace("\\", "/")
    if ".." in normalized:
        return jsonify({"error": "Invalid static path"}), 400

    if normalized not in ALLOWED_STATIC_FILES and not normalized.startswith(ALLOWED_STATIC_PREFIXES):
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
    if len(password) < 6:
        raise ValidationError("Password must be at least 6 characters")

    result = auth_service.signup(email, password, display_name)
    return jsonify(result)


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

    return jsonify(result)


@app.route("/api/auth/logout", methods=["POST"])
@require_auth
def api_logout():
    """Sign out the current user."""
    token = request.headers.get("Authorization", "")[7:]
    auth_service.logout(token)
    session_mgr.remove_state(g.user_id)
    _log_event("user_logout", user_id=g.user_id)
    return jsonify({"success": True})


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
    df = _get_dataframe(filename, user_id=g.user_id, state=state)
    summary = data_service.get_summary(df)
    state.active_file["filename"] = filename

    state.query_cache.clear()
    state.clear_file_cache()
    state.set_cached(filename, "df", df)
    chat_session_service.ensure_active_session(state, filename=filename, force_new=True)
    _save_chat_history(user_id=g.user_id, state=state)

    _log_event("file_uploaded", user_id=g.user_id, filename=filename,
                rows=summary["shape"]["rows"], cols=summary["shape"]["columns"])

    return jsonify({
        "success": True,
        "filename": filename,
        "path": filename,
        "summary": summary,
    })


@app.route("/api/data-summary/<path:filename>", methods=["GET"])
@require_auth
def data_summary(filename):
    """Get summary stats for a specific uploaded file."""
    state = _get_user_state()
    state.active_file["filename"] = filename
    active_session = chat_session_service.ensure_active_session(state, filename=filename)
    if not active_session.get("filename"):
        active_session["filename"] = filename
    df = _get_dataframe(filename, user_id=g.user_id, state=state)
    summary = data_service.get_summary(df)
    return jsonify({"filename": filename, "summary": summary})


@app.route("/api/data/<path:filename>", methods=["GET"])
@require_auth
def get_full_data(filename):
    """Get the full dataset for the data connector."""
    state = _get_user_state()
    state.active_file["filename"] = filename
    active_session = chat_session_service.ensure_active_session(state, filename=filename)
    if not active_session.get("filename"):
        active_session["filename"] = filename
    df = _get_dataframe(filename, user_id=g.user_id, state=state)
    data = [df.columns.tolist()] + df.fillna("").values.tolist()
    return jsonify({"filename": filename, "data": data})


@app.route("/api/suggest-questions", methods=["GET"])
@require_auth
@limiter.limit(app_config.RATE_LIMIT)
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
        usage_metadata = getattr(response, "usage_metadata", None)
        if usage_metadata is None:
            usage_dict = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        else:
            usage_dict = {
                "input_tokens": getattr(usage_metadata, "prompt_token_count", 0) or 0,
                "output_tokens": getattr(usage_metadata, "candidates_token_count", 0) or 0,
                "total_tokens": getattr(usage_metadata, "total_token_count", 0) or 0,
            }
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
    """Parse and validate a chat request. Returns (message, filename, user_id, state, skip_cache) or a Flask error response."""
    data = request.get_json()
    if not data or "message" not in data:
        return jsonify({"error": "No message provided"}), 400

    user_id = g.user_id
    state = _get_user_state()
    requested_session_id = (data.get("session_id") or "").strip()
    if requested_session_id:
        activated = chat_session_service.set_active_session(state, requested_session_id)
        if not activated:
            return _error_response("Chat session not found", status_code=404, error_type="session_not_found")

    message = data["message"]
    filename = data.get("filename") or state.active_file.get("filename")
    active_session = chat_session_service.ensure_active_session(state, filename=filename)
    if not filename:
        filename = active_session.get("filename")
    if filename:
        state.active_file["filename"] = filename
        if not active_session.get("filename"):
            active_session["filename"] = filename

    skip_cache = data.get("skip_cache", False)

    if not filename:
        return _error_response(
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
    parsed = _parse_chat_request()
    if isinstance(parsed, tuple) and len(parsed) == 2:
        return parsed  # Error response
    message, filename, user_id, state, skip_cache = parsed
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
            payload["session_id"] = state.active_session_id
            return jsonify(payload)
        if event_type == "error":
            status = payload.get("status_code", 500)
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
    parsed = _parse_chat_request()
    if isinstance(parsed, tuple) and len(parsed) == 2:
        return parsed  # Error response
    message, filename, user_id, state, skip_cache = parsed
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
                payload["session_id"] = state.active_session_id
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
    history = chat_session_service.get_active_messages(state)

    if not history:
        _load_chat_history_for_user(g.user_id)
        state = _get_user_state()
        history = chat_session_service.get_active_messages(state)

    page = request.args.get("page", 1, type=int)
    per_page = request.args.get("per_page", app_config.DEFAULT_PAGE_SIZE, type=int)

    reversed_history = list(reversed(history))
    result = _paginate(reversed_history, page, per_page)

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
        only_title = (only.get("title") or "").strip() if isinstance(only, dict) else ""
        if not only_messages and only_title in {"", "New Conversation"}:
            should_rehydrate = True

    if should_rehydrate:
        _load_chat_history_for_user(g.user_id)
        state = _get_user_state()

    return jsonify({
        "active_session_id": state.active_session_id,
        "sessions": chat_session_service.list_session_summaries(state),
    })


@app.route("/api/chat/sessions/new", methods=["POST"])
@require_auth
def create_chat_session():
    """Create a new chat session and set it active."""
    state = _get_user_state()
    data = request.get_json(silent=True) or {}
    requested_filename = data.get("filename") or state.active_file.get("filename")
    title = (data.get("title") or "").strip()[:80] or None

    session = chat_session_service.create_session(filename=requested_filename, title=title)
    state.chat_sessions.insert(0, session)
    state.active_session_id = session["id"]
    state.chat_history = session["messages"]

    _save_chat_history(user_id=g.user_id, state=state)
    return jsonify({"success": True, "session": session})


@app.route("/api/chat/sessions/<session_id>/activate", methods=["POST"])
@require_auth
def activate_chat_session(session_id):
    """Activate an existing chat session."""
    state = _get_user_state()
    session = chat_session_service.set_active_session(state, session_id)
    if not session:
        return _error_response("Chat session not found", status_code=404, error_type="session_not_found")

    if session.get("filename"):
        state.active_file["filename"] = session.get("filename")

    _save_chat_history(user_id=g.user_id, state=state)
    return jsonify({"success": True, "active_session_id": session_id})


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
        if active and active.get("filename"):
            state.active_file["filename"] = active.get("filename")
    else:
        state.active_file["filename"] = None

    _save_chat_history(user_id=g.user_id, state=state)
    return jsonify({"success": True, "active_session_id": state.active_session_id})


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
    usage_service.ensure_usage_state(state)
    state.usage_totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "cost_myr": 0.0,
        "updated_at": None,
    }
    state.message_request_times.clear()
    state.query_cache.clear()
    state.active_file["filename"] = None
    state.clear_file_cache()
    try:
        sb_service = auth_service.get_supabase_service()
        sb_service.table("chat_sessions").delete().eq("user_id", g.user_id).execute()
    except Exception as e:
        logger.error("Chat history clear failed from Supabase: %s", e)

    # Keep dashboard visuals aligned with clear-chat behavior.
    try:
        sb_service = auth_service.get_supabase_service()
        sb_service.table("dashboard_configs").delete().eq("user_id", g.user_id).execute()
    except Exception as e:
        logger.error("Dashboard clear failed from Supabase during chat clear: %s", e)

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
        session_id = resolve_requested_session_id(state)
        config = load_dashboard_store(g.user_id, session_id)
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
    session_id = resolve_requested_session_id(state, data)

    try:
        config = load_dashboard_store(g.user_id, session_id)
        config.setdefault("sessions", {})[session_id] = {
            "charts": charts,
            "cards": cards,
        }
        save_dashboard_store(g.user_id, config)
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
    session_id = resolve_requested_session_id(state, data)

    try:
        config = load_dashboard_store(g.user_id, session_id)
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

        save_dashboard_store(g.user_id, config)

        return jsonify({"success": True, "chart_id": new_chart["id"], "session_id": session_id})

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
        session_id = resolve_requested_session_id(state)
        config = load_dashboard_store(g.user_id, session_id)
        session_config = get_session_dashboard(config, session_id)
        session_config["charts"] = [c for c in session_config.get("charts", []) if c.get("id") != chart_id]
        config["sessions"][session_id] = session_config

        save_dashboard_store(g.user_id, config)

        return jsonify({"success": True, "session_id": session_id})

    except ValidationError:
        raise
    except Exception as e:
        logger.error("Chart removal failed: %s", e)
        return jsonify({"error": str(e)}), 500


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

        return jsonify({"success": True, "value": value})
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
    import ipaddress

    ssl_context = None
    protocol = "http"
    if app_config.HTTPS_ENABLED:
        cert_path, key_path = _generate_self_signed_cert()
        ssl_context = (cert_path, key_path)
        protocol = "https"

    _log_event("server_start", port=app_config.PORT, debug=app_config.DEBUG,
               protocol=protocol)
    app.run(debug=app_config.DEBUG, port=app_config.PORT, ssl_context=ssl_context)

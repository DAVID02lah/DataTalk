"""
server.py — Flask API server for Data Talk.

Serves static HTML files and provides REST API endpoints for:
- User authentication (Supabase Auth)
- File upload
- Gemini chat analysis
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
import hashlib
import logging
from flask import Flask, request, jsonify, send_from_directory, g, Response, stream_with_context
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge

import app_config
from app_state import SessionManager
import data_service
import gemini_service
import code_executor
import auth_service
from auth_service import require_auth

# --- Flask App Setup ---
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

ALLOWED_STATIC_FILES = {
    "index.html",
    "dashboard.html",
    "login.html",
    "styles.css",
    "dashboard.css",
    "script.js",
}
ALLOWED_STATIC_PREFIXES = (
    "assets/",
    "js/",
    "css/",
)


def _log_event(event, **fields):
    """Emit one-line structured logs for easier filtering."""
    payload = {"event": event, **fields}
    logger.info(json.dumps(payload, default=str))


def _get_user_state():
    """Get the per-user state for the current authenticated request."""
    return session_mgr.get_state(g.user_id)


# Removed local path helpers as we use Supabase now


def _save_chat_history(user_id=None, state=None):
    """Persist chat history to Supabase for the current user."""
    try:
        # Use provided ID/state if available, otherwise fall back to context objects
        # We check explicitly to avoid triggering context errors if they are provided.
        if user_id and state:
            uid = user_id
            st = state
        else:
            uid = g.user_id
            st = _get_user_state()
        
        sb_service = auth_service.get_supabase_service()
        # Upsert into chat_sessions table
        sb_service.table("chat_sessions").upsert({
            "user_id": uid,
            "filename": st.active_file.get("filename"),
            "history": st.chat_histories,
            "updated_at": "now()"
        }, on_conflict="user_id, filename").execute()
    except Exception as e:
        logger.error("Chat history save failed to Supabase: %s", e)


def _load_chat_history_for_user(user_id):
    """Load chat history from Supabase for a specific user."""
    state = session_mgr.get_state(user_id)
    try:
        sb_service = auth_service.get_supabase_service()
        # Fetch the most recent chat session for this user
        result = sb_service.table("chat_sessions") \
            .select("filename, history") \
            .eq("user_id", user_id) \
            .order("updated_at", desc=True) \
            .limit(1).execute()
        
        if result.data:
            session = result.data[0]
            state.active_file["filename"] = session.get("filename")
            state.chat_histories = session.get("history", {})
            _log_event("active_file_rehydrated", user_id=user_id, filename=session.get("filename"))
    except Exception as e:
        logger.error("Chat history load failed from Supabase: %s", e)


# ==============================================================
# Static File Serving
# ==============================================================

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
# API: Authentication
# ==============================================================

@app.route("/api/auth/signup", methods=["POST"])
def api_signup():
    """Register a new user."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    email = data.get("email", "").strip()
    password = data.get("password", "")
    display_name = data.get("display_name", "").strip()

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    result = auth_service.signup(email, password, display_name)
    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)


@app.route("/api/auth/login", methods=["POST"])
def api_login():
    """Authenticate a user and return tokens."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    email = data.get("email", "").strip()
    password = data.get("password", "")

    if not email or not password:
        return jsonify({"error": "Email and password are required"}), 400

    result = auth_service.login(email, password)
    if result.get("error"):
        return jsonify(result), 401

    # Load user state from disk on login
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
    _log_event("user_logout", user_id=g.user_id)
    return jsonify({"success": True})


@app.route("/api/auth/session", methods=["GET"])
@require_auth
def api_session():
    """Validate the current session and return user info."""
    # Rehydrate user state from Supabase if not already loaded
    state = _get_user_state()
    if not state.chat_histories and not state.active_file.get("filename"):
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


# ==============================================================
# API: File Upload
# ==============================================================

@app.route("/api/upload", methods=["POST"])
@require_auth
def upload_file():
    """
    Upload a CSV/Excel file.
    Returns: filename, column info, row count, preview data.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    # Check extension
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in (".csv", ".xlsx", ".xls"):
        return jsonify({"error": f"Unsupported file type: {ext}. Use CSV or Excel."}), 400

    try:
        filename, _ = data_service.save_uploaded_file(file, user_id=g.user_id)
        df = data_service.load_file(filename, user_id=g.user_id)
        summary = data_service.get_summary(df)

        state = _get_user_state()
        state.active_file["filename"] = filename

        # Reset chat history and query cache for new file
        state.chat_histories.clear()
        state.query_cache.clear()
        state.clear_file_cache()

        _log_event("file_uploaded", user_id=g.user_id, filename=filename,
                    rows=summary["shape"]["rows"], cols=summary["shape"]["columns"])

        return jsonify({
            "success": True,
            "filename": filename,
            "summary": summary
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/files", methods=["GET"])
@require_auth
def list_files():
    """List all uploaded files for the current user."""
    files = data_service.list_uploaded_files(user_id=g.user_id)
    state = _get_user_state()
    return jsonify({"files": files, "active": state.active_file["filename"]})


@app.route("/api/data-summary/<filename>", methods=["GET"])
@require_auth
def data_summary(filename):
    """Get summary stats for a specific uploaded file."""
    try:
        df = data_service.load_file(filename, user_id=g.user_id)
        summary = data_service.get_summary(df)
        return jsonify({"filename": filename, "summary": summary})
    except FileNotFoundError:
        return jsonify({"error": f"File not found: {filename}"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/<filename>", methods=["GET"])
@require_auth
def get_full_data(filename):
    """Get the full dataset for the data connector."""
    try:
        df = data_service.load_file(filename, user_id=g.user_id)
        data = [df.columns.tolist()] + df.fillna("").values.tolist()
        return jsonify({"filename": filename, "data": data})
    except FileNotFoundError:
        return jsonify({"error": f"File not found: {filename}"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/suggest-questions", methods=["GET"])
@require_auth
def suggest_questions():
    """
    Ask Gemini to suggest 4 smart questions based on the active dataset.
    Returns: { "questions": ["...", "...", "...", "..."] }
    """
    state = _get_user_state()
    filename = state.active_file.get("filename")
    if not filename:
        return jsonify({"questions": []})

    try:
        df = data_service.load_file(filename, user_id=g.user_id)
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
        _log_token_usage({
            "input_tokens": usage_dict["input_tokens"],
            "output_tokens": usage_dict["output_tokens"],
            "total_tokens": usage_dict["total_tokens"],
        }, "Suggest Questions")


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
# Helpers
# ==============================================================

def _log_token_usage(usage, label="LLM interaction"):
    """Print token usage to terminal in a clean format."""
    if not usage:
        return
    input_t = usage.get("input_tokens", 0)
    output_t = usage.get("output_tokens", 0)
    total_t = usage.get("total_tokens", 0)
    _log_event("token_usage", label=label, input_tokens=input_t, output_tokens=output_t, total_tokens=total_t)


def _error_response(message, status_code=500, error_type="server_error"):
    """Return a standardized JSON error with proper HTTP status code."""
    return jsonify({
        "error": True,
        "error_type": error_type,
        "text": message,
        "chart": None,
        "table": None,
        "stats": None,
        "followup": [],
    }), status_code

@app.route("/api/chat", methods=["POST"])
@require_auth
def chat():
    """
    Send a message to Gemini for data analysis.
    Body: { "message": "...", "filename": "..." (optional), "skip_cache": false }
    Returns: { "text": "...", "chart": {...} or null, "cached": bool }
    """
    data = request.get_json()
    if not data or "message" not in data:
        return jsonify({"error": "No message provided"}), 400

    state = _get_user_state()
    message = data["message"]
    filename = data.get("filename") or state.active_file.get("filename")
    skip_cache = data.get("skip_cache", False)

    if not filename:
        return _error_response(
            "Please upload a dataset first! Go to the **Data Connector** tab and upload a CSV or Excel file.",
            status_code=400,
            error_type="no_file"
        )

    try:

        # Build cache key from message + filename
        cache_key = hashlib.md5(f"{filename}:{message}".encode()).hexdigest()

        # Check cache (unless skip_cache is True, used by regenerate)
        if not skip_cache and cache_key in state.query_cache:
            cached_result = state.query_cache.get(cache_key)
            if cached_result:
                cached_result = cached_result.copy()
                cached_result["cached"] = True
                _log_event("chat_cache_hit", user_id=g.user_id, filename=filename)
                return jsonify(cached_result)

        # Load the full dataset from Supabase
        df = data_service.load_file(filename, user_id=g.user_id)

        # Get chat history
        session_id = g.user_id
        history = state.chat_histories.get(session_id, [])

        # === Build context (cached per file) ===
        schema_context_lean = state.get_cached(filename, "schema_lean")
        if schema_context_lean is None:
            schema_context_lean = data_service.get_schema_string(df, max_tokens=2000)
            state.set_cached(filename, "schema_lean", schema_context_lean)

        profile = state.get_cached(filename, "profile")
        if profile is None:
            profile = data_service.get_data_profile(df)
            state.set_cached(filename, "profile", profile)
        profile_context = data_service.get_profile_string(profile)
        _log_event("profile_detected", dataset_type=profile["dataset_type"])

        # === Phase 0.5: Extract unique values from relevant columns ===
        extracted_data_context = None
        try:
            _log_event("extraction_started")
            extraction_code, usage = gemini_service.generate_data_extraction_code(message, schema_context_lean)
            _log_token_usage(usage, "Extraction")
            if extraction_code:
                extracted_data = code_executor.execute_extraction_code(extraction_code, df)
                if isinstance(extracted_data, dict) and not extracted_data.get("error"):
                    extracted_data_context = json.dumps(extracted_data, default=str)
                    _log_event("extraction_succeeded")
                else:
                    _log_event("extraction_failed")
        except Exception as e:
            _log_event("extraction_warning", error=str(e))

        # === Phase 1: Code Execution Pipeline with Retry ===
        MAX_RETRIES = app_config.MAX_RETRIES
        result = None
        schema_context_full = state.get_cached(filename, "schema_full")
        if schema_context_full is None:
            schema_context_full = data_service.get_schema_string(df, max_tokens=15000)
            state.set_cached(filename, "schema_full", schema_context_full)

        # Initial code generation (with extracted data context)
        # We cap history to prevent cumulative token bloat
        history_capped = history[-app_config.CHAT_HISTORY_CAP:] if history else []
        generated_code, usage = gemini_service.generate_analysis_code(
            message, schema_context_full, history_capped, profile_context, extracted_data_context
        )
        _log_token_usage(usage, "Code Gen")

        if generated_code:
            for attempt in range(1 + MAX_RETRIES):
                code_to_run = generated_code if attempt == 0 else last_code

                if code_to_run is None:
                    break

                attempt_label = "Initial" if attempt == 0 else f"Retry {attempt}/{MAX_RETRIES}"
                _log_event("code_exec_started", attempt=attempt_label, chars=len(code_to_run))

                exec_result = code_executor.execute_analysis_code(code_to_run, df)

                if not exec_result.get("error"):
                    result = exec_result
                    result["mode"] = "code_execution"
                    _log_event("code_exec_succeeded", attempt=attempt_label)

                    # === Send results to Gemini for interpretation ===
                    _log_event("interpret_started")
                    interpretation, usage = gemini_service.interpret_results(
                        message, schema_context_full, exec_result, history_capped
                    )
                    _log_token_usage(usage, "Interpret")
                    if interpretation:
                        result["text"] = interpretation
                        _log_event("interpret_succeeded")
                    else:
                        _log_event("interpret_failed")

                    break  # Success — exit retry loop
                else:
                    error_msg = exec_result.get("text", "Unknown error")
                    _log_event("code_exec_failed", error=error_msg)

                    if attempt < MAX_RETRIES:
                        # Retry: send the error back to Gemini for fixing
                        _log_event("retry_started", attempt=attempt + 1, max_retries=MAX_RETRIES)
                        last_code, usage = gemini_service.retry_analysis_code(
                            message, schema_context_full, code_to_run, error_msg, profile_context, extracted_data_context
                        )
                        _log_token_usage(usage, "Retry")
                        if last_code:
                            _log_event("retry_code_generated", chars=len(last_code))
                        else:
                            _log_event("retry_failed")
                            break
                    else:
                        _log_event("retry_exhausted")

        # === Phase 2: Fallback to text-based analysis ===
        if result is None:
            _log_event("fallback_analysis_started")
            data_context = data_service.get_context_string(df, max_rows=5) # Also lean fallback
            result = gemini_service.analyze_data(message, data_context, history_capped)
            _log_token_usage(result.get("usage"), "Fallback Text Analysis")
            if result.get("error"):
                return _error_response(
                    result.get("text", "AI service encountered an error."),
                    status_code=502,
                    error_type="gemini_error"
                )
            result["mode"] = "text_analysis"

        result["cached"] = False

        # Save to cache
        state.query_cache.set(cache_key, result)

        # Update chat history (include chart/table/stats for re-rendering)
        history.append({"role": "user", "text": message, "chart": None, "table": None, "stats": None})
        history.append({"role": "model", "text": result["text"], "chart": result.get("chart", None),
                         "table": result.get("table", None), "stats": result.get("stats", None)})
        state.chat_histories[session_id] = history
        _save_chat_history()

        return jsonify(result)

    except FileNotFoundError:
        return _error_response(
            f"File '{filename}' not found. Please upload it again.",
            status_code=404,
            error_type="file_not_found"
        )
    except Exception as e:
        return _error_response(
            f"Error analyzing data: {str(e)}",
            status_code=500,
            error_type="analysis_error"
        )


# ==============================================================
# API: Chat (SSE Streaming)
# ==============================================================

def _sse_event(event, data):
    """Format a single SSE event string."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.route("/api/chat/stream", methods=["POST"])
@require_auth
def chat_stream():
    """
    SSE streaming version of chat. Yields real-time phase updates.
    Body: { "message": "...", "filename": "..." (optional), "skip_cache": false }
    Events:
      phase  → { "phase": "...", "message": "..." }
      result → { full result JSON }
      error  → { "error": "...", "text": "..." }
      done   → {}
    """
    data = request.get_json()
    if not data or "message" not in data:
        return jsonify({"error": "No message provided"}), 400

    # Capture auth context before entering the generator (Flask g is request-local)
    user_id = g.user_id
    state = session_mgr.get_state(user_id)
    message = data["message"]
    filename = data.get("filename") or state.active_file.get("filename")
    skip_cache = data.get("skip_cache", False)

    if not filename:
        return jsonify({"error": "Please upload a dataset first!"}), 400

    def generate():
        try:
            # --- Cache check ---
            cache_key = hashlib.md5(f"{filename}:{message}".encode()).hexdigest()
            if not skip_cache and cache_key in state.query_cache:
                cached_result = state.query_cache.get(cache_key)
                if cached_result:
                    cached_result = cached_result.copy()
                    cached_result["cached"] = True
                    yield _sse_event("result", cached_result)
                    yield _sse_event("done", {})
                    return

            # --- Load dataset ---
            yield _sse_event("phase", {"phase": "loading", "message": "Loading dataset..."})
            df = data_service.load_file(filename, user_id=user_id)

            session_id = user_id
            history = state.chat_histories.get(session_id, [])

            # --- Build context ---
            schema_context_lean = state.get_cached(filename, "schema_lean")
            if schema_context_lean is None:
                schema_context_lean = data_service.get_schema_string(df, max_tokens=2000)
                state.set_cached(filename, "schema_lean", schema_context_lean)

            profile = state.get_cached(filename, "profile")
            if profile is None:
                profile = data_service.get_data_profile(df)
                state.set_cached(filename, "profile", profile)
            profile_context = data_service.get_profile_string(profile)

            # --- Phase 0.5: Extraction ---
            yield _sse_event("phase", {"phase": "extracting", "message": "Extracting relevant data..."})
            extracted_data_context = None
            try:
                extraction_code, usage = gemini_service.generate_data_extraction_code(message, schema_context_lean)
                _log_token_usage(usage, "Extraction")
                if extraction_code:
                    extracted_data = code_executor.execute_extraction_code(extraction_code, df)
                    if isinstance(extracted_data, dict) and not extracted_data.get("error"):
                        extracted_data_context = json.dumps(extracted_data, default=str)
            except Exception as e:
                _log_event("extraction_warning", error=str(e))

            # --- Phase 1: Code Generation ---
            yield _sse_event("phase", {"phase": "generating", "message": "Writing analysis code..."})
            MAX_RETRIES = app_config.MAX_RETRIES
            result = None
            schema_context_full = state.get_cached(filename, "schema_full")
            if schema_context_full is None:
                schema_context_full = data_service.get_schema_string(df, max_tokens=15000)
                state.set_cached(filename, "schema_full", schema_context_full)

            history_capped = history[-app_config.CHAT_HISTORY_CAP:] if history else []
            generated_code, usage = gemini_service.generate_analysis_code(
                message, schema_context_full, history_capped, profile_context, extracted_data_context
            )
            _log_token_usage(usage, "Code Gen")

            if generated_code:
                for attempt in range(1 + MAX_RETRIES):
                    code_to_run = generated_code if attempt == 0 else last_code
                    if code_to_run is None:
                        break

                    # --- Phase 2: Code Execution ---
                    attempt_label = "Initial" if attempt == 0 else f"Retry {attempt}/{MAX_RETRIES}"
                    yield _sse_event("phase", {
                        "phase": "executing",
                        "message": f"Running analysis ({attempt_label})..."
                    })

                    exec_result = code_executor.execute_analysis_code(code_to_run, df)

                    if not exec_result.get("error"):
                        result = exec_result
                        result["mode"] = "code_execution"

                        # --- Phase 3: Interpretation ---
                        yield _sse_event("phase", {"phase": "interpreting", "message": "Interpreting results..."})
                        interpretation, usage = gemini_service.interpret_results(
                            message, schema_context_full, exec_result, history_capped
                        )
                        _log_token_usage(usage, "Interpret")
                        if interpretation:
                            result["text"] = interpretation
                        break
                    else:
                        error_msg = exec_result.get("text", "Unknown error")
                        if attempt < MAX_RETRIES:
                            yield _sse_event("phase", {
                                "phase": "retrying",
                                "message": f"Fixing code (attempt {attempt + 1})..."
                            })
                            last_code, usage = gemini_service.retry_analysis_code(
                                message, schema_context_full, code_to_run, error_msg,
                                profile_context, extracted_data_context
                            )
                            _log_token_usage(usage, "Retry")
                            if not last_code:
                                break
                        else:
                            break

            # --- Fallback ---
            if result is None:
                yield _sse_event("phase", {"phase": "fallback", "message": "Using text-based analysis..."})
                data_context = data_service.get_context_string(df, max_rows=5)
                result = gemini_service.analyze_data(message, data_context, history_capped)
                _log_token_usage(result.get("usage"), "Fallback")
                if result.get("error"):
                    yield _sse_event("error", {
                        "error": True,
                        "text": result.get("text", "AI service error.")
                    })
                    yield _sse_event("done", {})
                    return
                result["mode"] = "text_analysis"

            result["cached"] = False

            # Save to cache
            state.query_cache.set(cache_key, result)

            # Update chat history
            history.append({"role": "user", "text": message, "chart": None, "table": None, "stats": None})
            history.append({"role": "model", "text": result["text"], "chart": result.get("chart"),
                            "table": result.get("table"), "stats": result.get("stats")})
            state.chat_histories[session_id] = history
            # Persist chat history to Supabase
            _save_chat_history(user_id=user_id, state=state)

            yield _sse_event("result", result)
            yield _sse_event("done", {})

        except FileNotFoundError:
            yield _sse_event("error", {"error": True, "text": f"File '{filename}' not found. Please upload it again."})
            yield _sse_event("done", {})
        except Exception as e:
            yield _sse_event("error", {"error": True, "text": f"Error analyzing data: {str(e)}"})
            yield _sse_event("done", {})

    return Response(stream_with_context(generate()), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })

@app.route("/api/chat/history", methods=["GET"])
@require_auth
def get_chat_history():
    """Get the current chat history."""
    state = _get_user_state()
    session_id = g.user_id
    history = state.chat_histories.get(session_id, [])
    
    # Fallback: if in-memory state is empty, try loading from Supabase
    if not history:
        _load_chat_history_for_user(g.user_id)
        state = _get_user_state()
        history = state.chat_histories.get(session_id, [])
    
    return jsonify({"history": history})


@app.route("/api/chat/clear", methods=["POST"])
@require_auth
def clear_chat():
    """Clear chat history (memory + file) and reset active file."""
    state = _get_user_state()
    state.chat_histories.clear()
    state.active_file["filename"] = None
    state.clear_file_cache()
    try:
        sb_service = auth_service.get_supabase_service()
        sb_service.table("chat_sessions").delete().eq("user_id", g.user_id).execute()
    except Exception as e:
        logger.error("Chat history clear failed from Supabase: %s", e)
    return jsonify({"success": True})


@app.route("/api/dashboard", methods=["GET"])
@require_auth
def get_dashboard():
    """Get the saved dashboard configuration from Supabase."""
    try:
        sb_service = auth_service.get_supabase_service()
        result = sb_service.table("dashboard_configs").select("config").eq("user_id", g.user_id).execute()
        if result.data and len(result.data) > 0:
            return jsonify(result.data[0]["config"])
        return jsonify({"charts": []})
    except Exception:
        return jsonify({"charts": []})


@app.route("/api/dashboard", methods=["POST"])
@require_auth
def save_dashboard():
    """Save dashboard configuration to Supabase."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    try:
        sb_service = auth_service.get_supabase_service()
        sb_service.table("dashboard_configs").upsert({
            "user_id": g.user_id,
            "config": data,
            "updated_at": "now()"
        }, on_conflict="user_id").execute()
        return jsonify({"success": True})
    except Exception as e:
        logger.error("Dashboard save failed to Supabase: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/pin", methods=["POST"])
@require_auth
def pin_chart():
    """Pin a single chart to the dashboard in Supabase."""
    data = request.get_json()
    if not data or "chart" not in data:
        return jsonify({"error": "No chart data provided"}), 400

    try:
        sb_service = auth_service.get_supabase_service()
        
        # 1. Fetch current config
        result = sb_service.table("dashboard_configs").select("config").eq("user_id", g.user_id).execute()
        config = result.data[0]["config"] if (result.data and len(result.data) > 0) else {"charts": []}
        
        charts_list = config.get("charts", [])
        if not isinstance(charts_list, list):
            charts_list = []
            
        # 2. Add new chart
        new_chart = {
            "id": f"chart_{int(time.time() * 1000)}",
            "title": data.get("title", "Untitled Chart"),
            "chart": data["chart"],
            "position": len(charts_list),
            "colSpan": 1
        }
        charts_list.append(new_chart)
        config["charts"] = charts_list
        
        # 3. Save back to Supabase
        sb_service.table("dashboard_configs").upsert({
            "user_id": g.user_id,
            "config": config,
            "updated_at": "now()"
        }, on_conflict="user_id").execute()

        return jsonify({"success": True, "chart_id": new_chart["id"]})

    except Exception as e:
        logger.error("Chart pin failed: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/remove/<chart_id>", methods=["DELETE"])
@require_auth
def remove_chart(chart_id):
    """Remove a chart from the dashboard in Supabase."""
    try:
        sb_service = auth_service.get_supabase_service()
        
        # 1. Fetch current config
        result = sb_service.table("dashboard_configs").select("config").eq("user_id", g.user_id).execute()
        if not result.data or len(result.data) == 0:
            return jsonify({"error": "No dashboard config found"}), 404
            
        config = result.data[0]["config"]
        
        # 2. Filter out the chart
        config["charts"] = [c for c in config.get("charts", []) if c.get("id") != chart_id]
        
        # 3. Save back to Supabase
        sb_service.table("dashboard_configs").upsert({
            "user_id": g.user_id,
            "config": config,
            "updated_at": "now()"
        }, on_conflict="user_id").execute()

        return jsonify({"success": True})

    except Exception as e:
        logger.error("Chart removal failed: %s", e)
        return jsonify({"error": str(e)}), 500


# ==============================================================
# Run
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
    import ipaddress  # Lazy import for self-signed cert SAN


    ssl_context = None
    protocol = "http"
    if app_config.HTTPS_ENABLED:
        cert_path, key_path = _generate_self_signed_cert()
        ssl_context = (cert_path, key_path)
        protocol = "https"

    _log_event("server_start", port=app_config.PORT, debug=app_config.DEBUG,
               protocol=protocol)
    app.run(debug=app_config.DEBUG, port=app_config.PORT, ssl_context=ssl_context)

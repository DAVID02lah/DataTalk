"""
server.py — Flask API server for Data Talk.

Serves static HTML files and provides REST API endpoints for:
- File upload
- Gemini chat analysis
- Dashboard config save/load
"""

import os
import re
import json
import time
import hashlib
import logging
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.exceptions import RequestEntityTooLarge

import app_config
from app_state import AppState
import data_service
import gemini_service
import code_executor

load_dotenv()

# --- Flask App Setup ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=BASE_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = app_config.MAX_CONTENT_LENGTH

cors_origins = app_config.get_allowed_cors_origins()
if cors_origins:
    CORS(app, resources={r"/api/*": {"origins": cors_origins}})
else:
    CORS(app)

DASHBOARD_CONFIG_PATH = os.path.join(data_service.UPLOAD_DIR, "dashboard_config.json")
CHAT_HISTORY_PATH = os.path.join(data_service.UPLOAD_DIR, "chat_history.json")

logger = logging.getLogger("data_talk")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

state = AppState()

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


def _load_chat_history():
    """Load chat history from disk on startup."""
    try:
        if os.path.exists(CHAT_HISTORY_PATH):
            with open(CHAT_HISTORY_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                state.chat_histories = data
    except Exception:
        state.chat_histories = {}

    # Rehydrate active_file
    try:
        files = data_service.list_uploaded_files()
        if files:
            state.active_file["filename"] = files[0]["filename"]
            _log_event("active_file_rehydrated", filename=files[0]["filename"])
    except Exception as e:
        _log_event("active_file_rehydrate_failed", error=str(e))


def _save_chat_history():
    """Persist chat history to disk."""
    try:
        data_service.ensure_upload_dir()
        with open(CHAT_HISTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(state.chat_histories, f, indent=2, default=str)
    except Exception as e:
        _log_event("chat_history_save_failed", error=str(e))


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
# API: File Upload
# ==============================================================

@app.route("/api/upload", methods=["POST"])
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
        filename, _ = data_service.save_uploaded_file(file)
        df = data_service.load_file(filename)
        summary = data_service.get_summary(df)

        # Set as active file
        state.active_file["filename"] = filename

        # Reset chat history and query cache for new file
        state.chat_histories.clear()
        state.query_cache.clear()
        state.clear_file_cache()

        _log_event("file_uploaded", filename=filename, rows=summary["shape"]["rows"], cols=summary["shape"]["columns"])

        return jsonify({
            "success": True,
            "filename": filename,
            "summary": summary
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/files", methods=["GET"])
def list_files():
    """List all uploaded files."""
    files = data_service.list_uploaded_files()
    return jsonify({"files": files, "active": state.active_file["filename"]})


@app.route("/api/data-summary/<filename>", methods=["GET"])
def data_summary(filename):
    """Get summary stats for a specific uploaded file."""
    try:
        df = data_service.load_file(filename)
        summary = data_service.get_summary(df)
        return jsonify({"filename": filename, "summary": summary})
    except FileNotFoundError:
        return jsonify({"error": f"File not found: {filename}"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/data/<filename>", methods=["GET"])
def get_full_data(filename):
    """Get the full dataset for the data connector."""
    try:
        df = data_service.load_file(filename)
        # Convert to list of lists with headers as first row for Handsontable
        data = [df.columns.tolist()] + df.fillna("").values.tolist()
        return jsonify({"filename": filename, "data": data})
    except FileNotFoundError:
        return jsonify({"error": f"File not found: {filename}"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/suggest-questions", methods=["GET"])
def suggest_questions():
    """
    Ask Gemini to suggest 4 smart questions based on the active dataset.
    Returns: { "questions": ["...", "...", "...", "..."] }
    """
    filename = state.active_file.get("filename")
    if not filename:
        return jsonify({"questions": []})

    try:
        df = data_service.load_file(filename)
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
def chat():
    """
    Send a message to Gemini for data analysis.
    Body: { "message": "...", "filename": "..." (optional), "skip_cache": false }
    Returns: { "text": "...", "chart": {...} or null, "cached": bool }
    """
    data = request.get_json()
    if not data or "message" not in data:
        return jsonify({"error": "No message provided"}), 400

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
                _log_event("chat_cache_hit", filename=filename)
                return jsonify(cached_result)

        # Load the full dataset
        df = data_service.load_file(filename)

        # Get chat history
        session_id = "default"  # Simple single-session approach
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


@app.route("/api/chat/history", methods=["GET"])
def get_chat_history():
    """Get the current chat history."""
    session_id = "default"
    history = state.chat_histories.get(session_id, [])
    return jsonify({"history": history})


@app.route("/api/chat/clear", methods=["POST"])
def clear_chat():
    """Clear chat history (memory + file) and reset active file."""
    state.chat_histories.clear()
    state.active_file["filename"] = None  # Reset active file
    state.clear_file_cache()
    try:
        if os.path.exists(CHAT_HISTORY_PATH):
            os.remove(CHAT_HISTORY_PATH)
    except Exception:
        pass
    return jsonify({"success": True})





# ==============================================================
# API: Dashboard Config
# ==============================================================

@app.route("/api/dashboard", methods=["GET"])
def get_dashboard():
    """Get the saved dashboard configuration (pinned charts)."""
    try:
        if os.path.exists(DASHBOARD_CONFIG_PATH):
            with open(DASHBOARD_CONFIG_PATH, "r", encoding="utf-8") as f:
                config = json.load(f)
            return jsonify(config)
        else:
            return jsonify({"charts": []})
    except Exception:
        return jsonify({"charts": []})


@app.route("/api/dashboard", methods=["POST"])
def save_dashboard():
    """
    Save dashboard configuration.
    Body: { "charts": [ { "id": "...", "title": "...", "chart": {...plotly}, "position": n } ] }
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    try:
        data_service.ensure_upload_dir()
        with open(DASHBOARD_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/pin", methods=["POST"])
def pin_chart():
    """
    Pin a single chart to the dashboard.
    Body: { "title": "...", "chart": {...plotly json} }
    """
    data = request.get_json()
    if not data or "chart" not in data:
        return jsonify({"error": "No chart data provided"}), 400

    try:
        # Load existing config (handle corrupt/legacy formats)
        config = {"charts": []}
        if os.path.exists(DASHBOARD_CONFIG_PATH):
            with open(DASHBOARD_CONFIG_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            # Normalize: ensure it's a dict with a "charts" list
            if isinstance(loaded, dict) and "charts" in loaded:
                config = loaded
            elif isinstance(loaded, list):
                config = {"charts": loaded}
            # else keep default

        # Add new chart

        charts_list = config.get("charts", [])
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
        config["charts"] = charts_list

        # Save
        data_service.ensure_upload_dir()
        with open(DASHBOARD_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, default=str)

        return jsonify({"success": True, "chart_id": new_chart["id"]})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dashboard/remove/<chart_id>", methods=["DELETE"])
def remove_chart(chart_id):
    """Remove a chart from the dashboard by its ID."""
    try:
        if not os.path.exists(DASHBOARD_CONFIG_PATH):
            return jsonify({"error": "No dashboard config"}), 404

        with open(DASHBOARD_CONFIG_PATH, "r", encoding="utf-8") as f:
            config = json.load(f)

        config["charts"] = [c for c in config.get("charts", []) if c.get("id") != chart_id]

        with open(DASHBOARD_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, default=str)

        return jsonify({"success": True})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ==============================================================
# Run
# ==============================================================

if __name__ == "__main__":
    data_service.ensure_upload_dir()
    _load_chat_history()
    _log_event("server_start", port=app_config.PORT, debug=app_config.DEBUG, upload_dir=data_service.UPLOAD_DIR)
    app.run(debug=app_config.DEBUG, port=app_config.PORT)

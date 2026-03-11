"""Application configuration helpers for Data Talk."""

import os


def get_bool_env(name, default=False):
    """Read a boolean environment variable."""
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_int_env(name, default):
    """Read an integer environment variable safely."""
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def get_allowed_cors_origins():
    """Return configured CORS origins from env, if any."""
    raw = os.getenv("CORS_ALLOWED_ORIGINS", "")
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or None


DEBUG = get_bool_env("FLASK_DEBUG", False)
PORT = get_int_env("PORT", 5000)
MAX_UPLOAD_MB = get_int_env("MAX_UPLOAD_MB", 10)
MAX_CONTENT_LENGTH = MAX_UPLOAD_MB * 1024 * 1024

# Magic Numbers extracted from backend execution logic
MAX_RETRIES = get_int_env("MAX_RETRIES", 2)
CHAT_HISTORY_CAP = get_int_env("CHAT_HISTORY_CAP", 5)
QUERY_CACHE_SIZE = get_int_env("QUERY_CACHE_SIZE", 300)
EXEC_TIMEOUT = get_int_env("EXEC_TIMEOUT", 60)

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


def get_float_env(name, default):
    """Read a float environment variable safely."""
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


DEBUG = get_bool_env("FLASK_DEBUG", False)
PORT = get_int_env("PORT", 5000)
HTTPS_ENABLED = get_bool_env("HTTPS_ENABLED", False)


def get_allowed_cors_origins():
    """Return configured CORS origins from env, or a safe default."""
    raw = os.getenv("CORS_ALLOWED_ORIGINS", "")
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    # Restricted defaults: only allow local access if not configured
    protocol = "https" if HTTPS_ENABLED else "http"
    return [
        f"{protocol}://localhost:{PORT}",
        f"{protocol}://[127.0.0.1]"
    ]


MAX_UPLOAD_MB = get_int_env("MAX_UPLOAD_MB", 1)
MAX_CONTENT_LENGTH = MAX_UPLOAD_MB * 1024 * 1024

# Magic Numbers extracted from backend execution logic
MAX_RETRIES = get_int_env("MAX_RETRIES", 2)
CHAT_HISTORY_CAP = get_int_env("CHAT_HISTORY_CAP", 5)
QUERY_CACHE_SIZE = get_int_env("QUERY_CACHE_SIZE", 300)
EXEC_TIMEOUT = get_int_env("EXEC_TIMEOUT", 60)

# Rate Limiting
RATE_LIMIT = os.getenv("RATE_LIMIT", "5 per minute")

# Gemini Flash Lite pricing conversion helper.
USD_TO_MYR_RATE = get_float_env("USD_TO_MYR_RATE", 4.70)

# Pagination
DEFAULT_PAGE_SIZE = get_int_env("DEFAULT_PAGE_SIZE", 50)
MAX_PAGE_SIZE = get_int_env("MAX_PAGE_SIZE", 200)

# Sessions
SESSION_TTL_SECONDS = get_int_env("SESSION_TTL_SECONDS", 86400)

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# HTTPS
SSL_CERT_PATH = os.getenv("SSL_CERT_PATH", "certs/cert.pem")
SSL_KEY_PATH = os.getenv("SSL_KEY_PATH", "certs/key.pem")

# centralised configuaration for backend

import os

DEBUG = False
PORT = int(os.getenv("PORT", "5000"))  # no need admin root permission
HOST = os.getenv("HOST", "0.0.0.0")   # listen to all network card on machi deveploment 
HTTPS_ENABLED = os.getenv("HTTPS_ENABLED", "").lower() in {"1", "true", "yes", "on"}
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "")

# build allowed list of web address to access backend API, as 
# browser implement same origin policy, Cross Origin Resource Sharing
def get_allowed_cors_origins():
    #Build CORS origin list from env var, falling back to localhost for dev.
    if ALLOWED_ORIGINS: # Allow CORS for specific origins provided via environment variable
        return [o.strip() for o in ALLOWED_ORIGINS.split(",") if o.strip()]
    protocol = "https" if HTTPS_ENABLED else "http"
    return [
        f"{protocol}://localhost:{PORT}",
        f"{protocol}://127.0.0.1:{PORT}",
    ]

MAX_UPLOAD_MB = 1
MAX_CONTENT_LENGTH = MAX_UPLOAD_MB * 1024 * 1024

# Constant config extracted from backend execution logic
MAX_RETRIES = 2
CHAT_HISTORY_CAP = 10
QUERY_CACHE_SIZE = 300
EXEC_TIMEOUT = 60

# Rate Limiting
RATE_LIMIT = "100 per day"

# Gemini Flash Lite pricing conversion .
USD_TO_MYR_RATE = 4.00

# Pagination
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

# Sessions
SESSION_TTL_SECONDS = 86400
MAX_CHAT_SESSIONS = 2

# Performance
AUTH_TOKEN_CACHE_TTL_SECONDS = 600
DASHBOARD_STORE_CACHE_TTL_SECONDS = 120
SLOW_REQUEST_LOG_THRESHOLD_MS = 800

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# path to secure soket layer certificate and key, to turn standard http to
# encrypted https traffic 
SSL_CERT_PATH = "certs/cert.pem"
SSL_KEY_PATH = "certs/key.pem"

# Auth cookies
AUTH_ACCESS_COOKIE_NAME = "dt_access_token"
AUTH_REFRESH_COOKIE_NAME = "dt_refresh_token"
AUTH_COOKIE_PATH = "/"
AUTH_COOKIE_DOMAIN = None
AUTH_COOKIE_SAMESITE = "Lax"
AUTH_COOKIE_SECURE = HTTPS_ENABLED
AUTH_ACCESS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12
AUTH_REFRESH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

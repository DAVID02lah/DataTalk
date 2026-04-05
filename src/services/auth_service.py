"""
auth_service.py — Supabase Auth integration for Data Talk.

Handles user signup, login, JWT verification, and provides
a Flask decorator for protecting API routes.
"""

import base64
import functools
import json
import logging
import threading
import time
from flask import request, jsonify, g
from supabase import create_client, Client
from src.core import app_config
from src.core.errors import AuthenticationError, ValidationError

logger = logging.getLogger("data_talk.auth")

# --- Supabase Client ---
SUPABASE_URL = app_config.SUPABASE_URL
SUPABASE_ANON_KEY = app_config.SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY = app_config.SUPABASE_SERVICE_ROLE_KEY

_supabase: Client | None = None
_supabase_service: Client | None = None
_token_cache_lock = threading.Lock()
_verified_token_cache: dict[str, tuple[float, dict]] = {}


def _decode_jwt_exp_unverified(token: str) -> int | None:
    """Read JWT exp claim without verification to bound cache lifetime."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload = parts[1]
        padding = "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(f"{payload}{padding}".encode("ascii"))
        payload_json = json.loads(decoded.decode("utf-8"))
        exp_raw = payload_json.get("exp")
        exp_val = int(exp_raw)
        return exp_val if exp_val > 0 else None
    except Exception:
        return None


def _get_cached_verified_token(token: str) -> dict | None:
    now_ts = time.time()
    with _token_cache_lock:
        entry = _verified_token_cache.get(token)
        if not entry:
            return None
        expires_at, user_info = entry
        if expires_at <= now_ts:
            _verified_token_cache.pop(token, None)
            return None
        return user_info


def _set_cached_verified_token(token: str, user_info: dict) -> None:
    ttl = max(1, int(app_config.AUTH_TOKEN_CACHE_TTL_SECONDS or 1))
    now_ts = time.time()
    max_expires_at = now_ts + ttl

    token_exp = _decode_jwt_exp_unverified(token)
    if token_exp is not None:
        # Subtract a small safety window so we revalidate before token expiry.
        max_expires_at = min(max_expires_at, float(token_exp - 5))

    if max_expires_at <= now_ts:
        return

    with _token_cache_lock:
        expired_tokens = [
            cached_token
            for cached_token, (cached_expiry, _info) in _verified_token_cache.items()
            if cached_expiry <= now_ts
        ]
        for expired_token in expired_tokens:
            _verified_token_cache.pop(expired_token, None)

        _verified_token_cache[token] = (max_expires_at, user_info)

        if len(_verified_token_cache) > 1000:
            for cached_token in list(_verified_token_cache.keys())[:200]:
                if cached_token != token:
                    _verified_token_cache.pop(cached_token, None)


def _token_from_authorization_header(header_value: str) -> str | None:
    """Extract a bearer token from an Authorization header value."""
    value = str(header_value or "").strip()
    if not value.lower().startswith("bearer "):
        return None
    token = value[7:].strip()
    return token or None


def get_request_access_token() -> str | None:
    """Resolve access token from Authorization header first, then auth cookie."""
    header_token = _token_from_authorization_header(request.headers.get("Authorization", ""))
    if header_token:
        return header_token

    cookie_name = app_config.AUTH_ACCESS_COOKIE_NAME
    cookie_token = str(request.cookies.get(cookie_name, "")).strip()
    if cookie_token:
        return cookie_token
    return None


def get_supabase() -> Client:
    """Get or create the Supabase client singleton (anon)."""
    global _supabase
    if _supabase is None:
        if not SUPABASE_URL or not SUPABASE_ANON_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env"
            )
        _supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    return _supabase


def get_supabase_service() -> Client:
    """Get or create the Supabase service-role client (bypasses RLS)."""
    global _supabase_service
    if _supabase_service is None:
        key = SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY
        if key == SUPABASE_ANON_KEY:
            logger.warning("SUPABASE_SERVICE_ROLE_KEY not found; falling back to anon key (RLS may block requests).")
        _supabase_service = create_client(SUPABASE_URL, key)
    return _supabase_service


# --- Auth Operations ---

def signup(email: str, password: str, display_name: str = "") -> dict:
    """Register a new user via Supabase Auth."""
    sb = get_supabase()
    try:
        result = sb.auth.sign_up({
            "email": email,
            "password": password,
            "options": {
                "data": {"display_name": display_name or email.split("@")[0]}
            }
        })
        user = result.user
        session = result.session
        if not user:
            raise AuthenticationError("Signup failed — no user returned.")
        return {
            "success": True,
            "user": {
                "id": str(user.id),
                "email": user.email,
                "display_name": display_name or email.split("@")[0],
            },
            "access_token": session.access_token if session else None,
            "refresh_token": session.refresh_token if session else None,
        }
    except Exception as e:
        error_msg = str(e)
        logger.error("Signup error: %s", error_msg)
        if isinstance(e, AuthenticationError):
            raise
        raise AuthenticationError(error_msg)


def login(email: str, password: str) -> dict:
    """Authenticate a user and return JWT tokens."""
    sb = get_supabase()
    try:
        result = sb.auth.sign_in_with_password({
            "email": email,
            "password": password,
        })
        user = result.user
        session = result.session
        if not user or not session:
            raise AuthenticationError("Invalid email or password.")

        # Fetch profile for display name using service client
        display_name = email.split("@")[0]
        try:
            sb_service = get_supabase_service()
            profile = sb_service.table("profiles").select("display_name, avatar_initials").eq("id", str(user.id)).single().execute()
            if profile.data:
                display_name = profile.data.get("display_name", display_name)
        except Exception as e:
            logger.warning("Profile fetch during login failed (likely RLS): %s", e)

        return {
            "success": True,
            "user": {
                "id": str(user.id),
                "email": user.email,
                "display_name": display_name,
            },
            "access_token": session.access_token,
            "refresh_token": session.refresh_token,
        }
    except Exception as e:
        error_msg = str(e)
        logger.error("Login error: %s", error_msg)
        if isinstance(e, AuthenticationError):
            raise
        raise AuthenticationError(error_msg)


def verify_token(access_token: str) -> dict | None:
    """
    Verify a Supabase JWT access token by calling getUser().
    Returns user info dict or None if invalid.
    """
    cached = _get_cached_verified_token(access_token)
    if cached is not None:
        return cached

    sb = get_supabase()
    try:
        result = sb.auth.get_user(access_token)
        user = getattr(result, "user", None)
        if not user:
            return None
        user_info = {
            "id": str(user.id),
            "email": user.email,
        }
        _set_cached_verified_token(access_token, user_info)
        return user_info
    except Exception as e:
        logger.debug("Token verification failed: %s", e)
        return None


def get_profile(user_id: str) -> dict | None:
    """Fetch user profile from the profiles table using service client."""
    sb_service = get_supabase_service()
    try:
        result = sb_service.table("profiles").select("*").eq("id", user_id).execute()
        if result.data and len(result.data) > 0:
            return result.data[0]
        return None
    except Exception as e:
        logger.error("Error fetching profile for %s: %s", user_id, e)
        return None


def update_profile(user_id: str, display_name: str) -> dict:
    """Create or update a user's profile record."""
    cleaned = str(display_name or "").strip()
    if not cleaned:
        raise ValidationError("Display name is required")

    tokens = [part for part in cleaned.split() if part]
    if tokens:
        initials = "".join(token[0] for token in tokens[:2]).upper()
    else:
        initials = cleaned[:2].upper()

    payload = {
        "id": user_id,
        "display_name": cleaned[:80],
        "avatar_initials": initials[:2],
    }

    sb_service = get_supabase_service()
    try:
        sb_service.table("profiles").upsert(payload, on_conflict="id").execute()
        return payload
    except Exception as e:
        logger.error("Error updating profile for %s: %s", user_id, e)
        raise ValidationError("Failed to update profile")


def logout(access_token: str) -> bool:
    """Sign out the user (invalidates the refresh token server-side)."""
    sb = get_supabase()
    try:
        sb.auth._headers = {
            **sb.auth._headers,
            "Authorization": f"Bearer {access_token}",
        }
        sb.auth.sign_out()
        return True
    except Exception as e:
        logger.error("Logout error: %s", e)
        return False


# --- Flask Auth Decorator ---

def require_auth(f):
    """
    Flask route decorator that verifies the current access token.
    Accepts either Authorization Bearer token or secure auth cookie.
    Sets g.user_id, g.user_email, and g.access_token on success.
    Returns 401 if no valid token.
    """
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        token = get_request_access_token()
        if not token:
            raise AuthenticationError("Missing or invalid authentication token")

        user_info = verify_token(token)
        if not user_info:
            raise AuthenticationError("Invalid or expired token")

        g.user_id = user_info["id"]
        g.user_email = user_info["email"]
        g.access_token = token
        return f(*args, **kwargs)

    return decorated

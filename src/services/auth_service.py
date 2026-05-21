"""
auth_service.py — Supabase Auth integration for Data Talk.

Handles user signup, login, JWT verification, and provides
a Flask decorator for protecting API routes.
"""

import re
import base64
import functools
import hashlib
import json
import logging
import threading
import time
from flask import request, g
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

# Per-token locks prevent concurrent getUser() calls for the same token
# during cold-start or cache eviction windows.
_verification_locks: dict[str, threading.Lock] = {}
_verification_locks_guard = threading.Lock()


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


def _evict_cached_token(token: str) -> None:
    """Remove a token from the verification cache (e.g. on logout)."""
    with _token_cache_lock:
        _verified_token_cache.pop(token, None)


def _get_verification_lock(token_key: str) -> threading.Lock:
    """Return a stable lock for a token hash to deduplicate concurrent verifications."""
    with _verification_locks_guard:
        lock = _verification_locks.get(token_key)
        if lock is None:
            lock = threading.Lock()
            _verification_locks[token_key] = lock
        # Prevent unbounded growth of lock registry.
        if len(_verification_locks) > 500:
            for stale_key in list(_verification_locks.keys())[:200]:
                if stale_key != token_key:
                    _verification_locks.pop(stale_key, None)
        return lock


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

def _validate_password_complexity(password: str) -> None:
    """Validate password meets security policies."""
    if len(password) < 8:
        raise ValidationError("Password must be at least 8 characters.")
    
    # Must contain at least one letter to prevent passwords made entirely of symbols/numbers
    if not re.search(r'[a-zA-Z]', password):
        raise ValidationError("Password must contain at least one letter (a-z, A-Z).")
        
    # Must contain at least one special character
    if not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        raise ValidationError("Password must contain at least one special character (e.g., @, #, $, %).")

def signup(email: str, password: str, display_name: str = "") -> dict:
    """Register a new user via Supabase Auth."""
    _validate_password_complexity(password)
    
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
    Verify a Supabase JWT access token.
    Uses a dedup lock so concurrent cold-start requests only trigger one
    network call for the same token.
    """
    cached = _get_cached_verified_token(access_token)
    if cached is not None:
        return cached

    # Serialise concurrent verifications of the same token to avoid
    # a thundering-herd of getUser() calls on server cold-start.
    token_key = hashlib.sha256(access_token.encode()).hexdigest()[:16]
    lock = _get_verification_lock(token_key)
    with lock:
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
        "display_name": cleaned[:50],
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
    # Evict before the network call so a captured token is immediately
    # rejected even if the Supabase call fails.
    _evict_cached_token(access_token)
    try:
        sb = get_supabase_service()
        sb.auth.admin.sign_out(access_token)
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


def reset_password(email: str, redirect_to: str = None) -> dict:
    """Send a password reset email to the user."""
    sb = get_supabase()
    try:
        opt = {}
        if redirect_to:
            opt["redirect_to"] = redirect_to
        sb.auth.reset_password_email(email, options=opt)
        return {"success": True}
    except Exception as e:
        error_msg = str(e)
        logger.error("Reset password error: %s", error_msg)
        if isinstance(e, AuthenticationError):
            raise
        raise AuthenticationError(error_msg)


def update_password(access_token: str, new_password: str) -> dict:
    """Update user password using a recovery access token."""
    _validate_password_complexity(new_password)
    
    try:
        user_info = verify_token(access_token)
        if not user_info:
            raise AuthenticationError("Invalid or expired recovery token")

        user_id = user_info['id']
        admin_sb = get_supabase_service()
        admin_sb.auth.admin.update_user_by_id(user_id, {"password": new_password})
        
        return {"success": True}
    except Exception as e:
        error_msg = str(e)
        logger.error("Update password error: %s", error_msg)
        if isinstance(e, AuthenticationError):
            raise
        raise AuthenticationError(error_msg)


def delete_account(user_id: str) -> None:
    """Delete all user database records, storage files, and their Supabase Auth account."""
    sb_service = get_supabase_service()

    # 1. Clean up user storage files first (dynamic import to avoid circular dependency)
    try:
        from src.services.data_service import get_dataset_bucket
        from werkzeug.utils import secure_filename
        
        bucket = get_dataset_bucket()
        user_prefix = secure_filename(str(user_id))
        
        entries = bucket.list(user_prefix)
        if entries:
            paths = [
                f"{user_prefix}/{entry['name']}"
                for entry in entries
                if isinstance(entry, dict) and "name" in entry
            ]
            if paths:
                bucket.remove(paths)
                logger.info("Successfully deleted storage files for user %s: %s", user_id, paths)
    except Exception as e:
        logger.error("Failed to delete storage files for user %s: %s", user_id, e)

    # 2. Delete database rows using the service client to bypass RLS/foreign key blockers
    for table_name in ("dashboard_configs", "chat_sessions", "profiles"):
        try:
            sb_service.table(table_name).delete().eq("user_id" if table_name != "profiles" else "id", user_id).execute()
            logger.info("Successfully deleted user %s records from %s", user_id, table_name)
        except Exception as e:
            logger.error("Failed to delete from %s during user deletion: %s", table_name, e)

    # 3. Delete the user from Supabase Auth
    try:
        sb_service.auth.admin.delete_user(user_id)
        logger.info("Successfully deleted user auth record %s from Supabase Auth", user_id)
    except Exception as e:
        logger.error("Failed to delete user %s from Supabase Auth: %s", user_id, e)
        raise ValidationError("Failed to delete account from authentication server.")

"""
auth_service.py — Supabase Auth integration for Data Talk.

Handles user signup, login, JWT verification, and provides
a Flask decorator for protecting API routes.
"""

import logging
import functools
from flask import request, jsonify, g
from supabase import create_client, Client
import app_config
from errors import AuthenticationError, ValidationError

logger = logging.getLogger("data_talk.auth")

# --- Supabase Client ---
SUPABASE_URL = app_config.SUPABASE_URL
SUPABASE_ANON_KEY = app_config.SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY = app_config.SUPABASE_SERVICE_ROLE_KEY

_supabase: Client | None = None
_supabase_service: Client | None = None


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
    sb = get_supabase()
    try:
        result = sb.auth.get_user(access_token)
        user = result.user
        if not user:
            return None
        return {
            "id": str(user.id),
            "email": user.email,
        }
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
    Flask route decorator that verifies the Authorization header.
    Sets g.user_id and g.user_email on success.
    Returns 401 if no valid token.
    """
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            raise AuthenticationError("Missing or invalid Authorization header")

        token = auth_header[7:]  # Strip "Bearer "
        user_info = verify_token(token)
        if not user_info:
            raise AuthenticationError("Invalid or expired token")

        g.user_id = user_info["id"]
        g.user_email = user_info["email"]
        return f(*args, **kwargs)

    return decorated

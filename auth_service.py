"""
auth_service.py — Supabase Auth integration for Data Talk.

Handles user signup, login, JWT verification, and provides
a Flask decorator for protecting API routes.
"""

import os
import logging
import functools
from flask import request, jsonify, g
from supabase import create_client, Client

logger = logging.getLogger("data_talk.auth")

# --- Supabase Client ---
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")

_supabase: Client | None = None


def get_supabase() -> Client:
    """Get or create the Supabase client singleton."""
    global _supabase
    if _supabase is None:
        if not SUPABASE_URL or not SUPABASE_ANON_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env"
            )
        _supabase = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    return _supabase


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
            return {"error": "Signup failed — no user returned."}
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
        return {"error": error_msg}


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
            return {"error": "Invalid email or password."}

        # Fetch profile for display name
        display_name = email.split("@")[0]
        try:
            profile = sb.table("profiles").select("display_name, avatar_initials").eq("id", str(user.id)).single().execute()
            if profile.data:
                display_name = profile.data.get("display_name", display_name)
        except Exception:
            pass

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
        return {"error": error_msg}


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
    """Fetch user profile from the profiles table."""
    sb = get_supabase()
    try:
        result = sb.table("profiles").select("*").eq("id", user_id).single().execute()
        return result.data
    except Exception:
        return None


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
            return jsonify({"error": "Missing or invalid Authorization header"}), 401

        token = auth_header[7:]  # Strip "Bearer "
        user_info = verify_token(token)
        if not user_info:
            return jsonify({"error": "Invalid or expired token"}), 401

        g.user_id = user_info["id"]
        g.user_email = user_info["email"]
        return f(*args, **kwargs)

    return decorated

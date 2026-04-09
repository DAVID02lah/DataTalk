# DataTalk — Bug Report & Code Reduction Guide (v2)

> **Last audited:** 2026-04-09 | **Codebase revision:** post-refactor (Blueprint-split + rate-limit update)
> This report supersedes v1. Every item from v1 is re-evaluated against the current code.

---

## Audit Status vs. v1 Issues

| # | v1 Issue | Status |
|---|---|---|
| 1 | `import ipaddress` inside `__main__` | ✅ **Fixed** — moved to top-level imports (line 22) |
| 2 | Thread-based timeout leaks | ✅ **Fixed** — migrated to `multiprocessing.Process` with `process.terminate()` |
| 3 | `logout()` mutates shared client headers | ⚠️ **Partially fixed** — creates fresh client but still mutates `_headers` |
| 4 | `_parse_chat_request()` ambiguous tuple return | ✅ **Fixed** — now raises `DataTalkError` directly |
| 5 | `analyse_data()` unguarded `usage_metadata` | ✅ **Fixed** — `_extract_usage_dict()` centralized in `gemini_service.py` |
| 6 | `.limit(1)` in `_load_chat_history_for_user()` | ⚠️ **Open** — still present, still undocumented |
| 7 | Duplicate `get_supabase_service()` in `clear_chat` | ✅ **Fixed** — extracted to one call with null-guard |
| 8 | `_fmt()` defined inside loop | ✅ **Fixed** — `_format_schema_value()` at module scope |
| 9 | `enforce_session_limit()` over-called | ⚠️ **Open** — still called in multiple places per request |
| 10 | `resolve_requested_session_id` wrong positional arg | ✅ **Fixed** — uses `request_data=data` consistently |
| 11 | Shallow sandbox (`getattr(builtins,...)`escape) | ⚠️ **Open** — structural limitation unchanged |
| 12 | `load_dotenv()` in `gemini_service.py` | ✅ **Fixed** — removed |
| 13 | `PyJWT` unused dependency | ✅ **Fixed** — removed from `requirements.txt` |
| 14 | `ALLOWED_STATIC_FILES` incomplete set | ✅ **Fixed** — replaced with `ALLOWED_STATIC_PREFIXES` tuple |
| 15 | `history_write_executor` never shut down | ⚠️ **Open** — no `atexit` or teardown hook |
| 16 | `enforce_session_limit()` on every request | ⚠️ **Open** — still unconditional in `_get_user_state()` |
| 17 | `dashboard.css` barrel file | ✅ **Fixed** — removed; CSS merged from 7 → 4 files |
| 18 | Wrong `MODEL_ID` default | ⚠️ **Open** — still `"gemini-3.1-flash-lite-preview"` |
| 19 | Full JSONB fetch on every dashboard read | ⚠️ **Open** — in-memory TTL cache added (partially mitigates) |
| D1–D9 | Dead / redundant code | ✅ Most fixed (D2,D3,D5,D6,D7,D8,D9,R3,R4,R1) |
| R5 | `resolve_requested_session_id` coupling | ✅ **Fixed** — moved to `chat_session_service.py` |
| R6 | `server.py` 1,270 lines | ⚠️ **Open** — now 1,219 lines; Blueprint split not yet done |

---

## Summary

| Category | Count |
|---|---|
| 🔴 Critical Bugs | 2 |
| 🟠 Medium Bugs / Logic Errors | 5 |
| 🟡 Minor Issues / Code Smells | 6 |
| 🗑️ Dead / Redundant Code | 4 |
| ♻️ Refactor / Reduction Opportunities | 3 |

---

## 🔴 Critical Bugs

### 1. `logout()` creates fresh client but still mutates its private `_headers`

**File:** [`src/services/auth_service.py:283–287`](file:///c:/Users/DAVID/Desktop/DataTalk/src/services/auth_service.py#L283)

```python
def logout(access_token: str) -> bool:
    try:
        # Creates a fresh client — good. But then mutates its internal state:
        sb = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        sb.auth._headers.update({"Authorization": f"Bearer {access_token}"})
        # sign_out() is never called — the function returns False after the except
    except Exception as e:
        logger.error("Logout error: %s", e)
        return False
```

There are **two distinct bugs** here:
1. `_headers` is a private dict on the supabase-py auth client — mutating it is relying on an uncontracted internal. A supabase-py library update could break this silently.
2. **`sb.auth.sign_out()` is never called**. The function mutates headers then falls through to the `except` block, which returns `False`. The user is never actually signed out server-side — only the cookie is cleared client-side.

**Fix:** Use the supabase-py documented sign-out API correctly:
```python
def logout(access_token: str) -> bool:
    try:
        sb = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        # Pass token via the standard session-style sign_out
        sb.auth.admin.sign_out(access_token)
        return True
    except Exception as e:
        logger.error("Logout error: %s", e)
        return False
```

---

### 2. Dead code after `raise` creates a silent execution gap in `_run_with_timeout()`

**File:** [`src/services/code_executor.py:191–194`](file:///c:/Users/DAVID/Desktop/DataTalk/src/services/code_executor.py#L191)

```python
    if not queue.empty():
        result_holder = queue.get()
    else:
        raise RuntimeError("Code execution ended without returning a result.")
        tb_lines = tb.strip().split("\n") if tb else []   # ← UNREACHABLE
        short_tb = "\n".join(tb_lines[-3:])               # ← UNREACHABLE
        raise RuntimeError(f"Code execution error: {err}\n{short_tb}")  # ← UNREACHABLE
```

Lines 192–194 are **completely unreachable** — they sit after an unconditional `raise`. The variables `tb` and `err` are also not defined in this scope (they were from the old thread-based implementation). If anyone ever restructures the surrounding code, these lines could cause a `NameError` instead of the intended error message.

**Fix:** Delete lines 192–194.

---

## 🟠 Medium Bugs / Logic Errors

### 3. `MODEL_ID` default points to a non-existent Gemini model

**File:** [`src/services/gemini_service.py:22`](file:///c:/Users/DAVID/Desktop/DataTalk/src/services/gemini_service.py#L22)

```python
MODEL_ID = os.getenv("GEMINI_MODEL_ID", "gemini-3.1-flash-lite-preview")
```

`gemini-3.1-flash-lite-preview` does not exist. The correct model name (as of 2025) is `gemini-2.0-flash-lite`. If `GEMINI_MODEL_ID` is not set in `.env`, every single API call will fail with a model-not-found error at runtime — a silent misconfiguration that only surfaces under load.

**Fix:** Update the fallback default:
```python
MODEL_ID = os.getenv("GEMINI_MODEL_ID", "gemini-2.0-flash-lite")
```

---

### 4. `history_write_executor` has no shutdown handler — pending writes lost on crash

**File:** [`server.py:68`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py#L68)

```python
history_write_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="chat-history")
```

There is no `atexit` registration or Flask teardown hook. On `SIGTERM` / unexpected crash, in-flight async history writes submitted to this executor will be silently dropped. Chat history corruption can result.

**Fix:**
```python
import atexit
history_write_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="chat-history")
atexit.register(history_write_executor.shutdown, wait=True)
```

---

### 5. `_load_chat_history_for_user()` uses `.limit(1)` with no documentation

**File:** [`server.py:248–252`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py#L248)

```python
result = sb_service.table("chat_sessions") \
    .select("filename, history") \
    .eq("user_id", user_id) \
    .order("updated_at", desc=True) \
    .limit(1).execute()   # ← implicitly assumes one row per user
```

The schema stores all sessions in a single JSON blob per user, so `.limit(1)` happens to be correct today. However, this assumption is **not documented anywhere** in the code. A future developer who adds per-session rows will break hydration silently — only the most recent session will be restored.

**Fix:** Add an explicit comment:
```python
# One row per user — all sessions serialised into the `history` JSON column.
# If the schema ever migrates to per-session rows, this limit must be removed.
.limit(1).execute()
```

---

### 6. `syncActiveSessionFile()` has a redundant, always-false `if` branch

**File:** [`js/data-chat.js:784–798`](file:///c:/Users/DAVID/Desktop/DataTalk/js/data-chat.js#L784)

```javascript
async function syncActiveSessionFile() {
    const activeSession = (App.state.chatSessions || []).find(s => s.id === App.state.activeSessionId);
    const path = activeSession?.filename;

    if (path) {
        await loadDatasetForPath(path, { silent: true, forceReload: true });
        return;          // ← always returns here if path is truthy
    }

    if (!path) {         // ← this branch is ALWAYS true when reached
        clearActiveFileUI();
    }
    // No else — the second if is redundant; just `else { clearActiveFileUI(); }` or
    // restructure as: if (path) { ... } else { clearActiveFileUI(); }
}
```

The second `if (!path)` check is logically redundant — control only reaches it when `path` is falsy (because the first `if (path)` returns early). This reads as a logic error to a future maintainer.

**Fix:**
```javascript
async function syncActiveSessionFile() {
    const activeSession = (App.state.chatSessions || []).find(s => s.id === App.state.activeSessionId);
    const path = activeSession?.filename;

    if (path) {
        await loadDatasetForPath(path, { silent: true, forceReload: true });
    } else {
        clearActiveFileUI();
    }
}
```

---

### 7. `clear_chat` resets `usage_totals` with an inline literal — schema coupling risk

**File:** [`server.py:947–954`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py#L947)

```python
state.usage_totals = {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0,
    "cost_usd": 0.0,
    "cost_myr": 0.0,
    "updated_at": None,
}
```

This duplicates the exact same structure already defined in `usage_service.ensure_usage_state()`. The route handler is directly constructing an internal data structure that belongs to the service layer. If `usage_service` ever adds a new field to `usage_totals`, `clear_chat` must also be manually updated — a silent schema drift hazard.

**Fix:** Replace the inline literal with a `usage_service` call:
```python
# Force re-initialisation to the canonical zero state from the service layer.
del state.usage_totals       # or setattr removal
usage_service.ensure_usage_state(state)
state.message_request_times.clear()
```

---

## 🟡 Minor Issues / Code Smells

### 8. `enforce_session_limit()` is called up to 4 times per chat request

**File:** [`server.py`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py) — multiple call sites

The session limit check runs in:
1. `_get_user_state()` — called by every `@require_auth` route
2. `_build_chat_session_payload()` — called after most session mutations
3. `upload_file()` — explicit call after upload
4. `create_chat_session()` — explicit call after creation

For every `/api/chat` request this runs **twice** (once in `_get_user_state`, once in `_build_chat_session_payload`). `enforce_session_limit()` iterates, sorts, and potentially rewrites all sessions on every invocation. It's harmless correctness-wise but wasteful for a "rate limiting" function.

**Pragmatic fix:** Add a dirty-flag or check `len(state.chat_sessions) > max_sessions` before entering the full sort/eviction logic. This is already partially done (early return on line 93) but the call sites themselves are not gated.

---

### 9. `save_full_data` route defines `_is_empty_row()` as an inner function

**File:** [`server.py:627–628`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py#L627)

```python
def _is_empty_row(values):
    return all(cell is None or str(cell).strip() == "" for cell in values)

while rows and _is_empty_row(rows[-1]):
    rows.pop()
```

This is a small, reusable predicate defined inside a route handler. It belongs at module scope (or in a `data_service` utility), not scoped to a single request. Defining functions inside request handlers obscures reuse and adds a minor overhead per request invocation.

**Fix:** Move `_is_empty_row` to module scope or inline the predicate into a list comprehension.

---

### 10. Sandbox weakness — attribute-access bypass not blocked by `_SafetyVisitor`

**File:** [`src/services/code_executor.py:95–105`](file:///c:/Users/DAVID/Desktop/DataTalk/src/services/code_executor.py#L95)

```python
def visit_Attribute(self, node):
    if node.attr.startswith("__") or node.attr in FORBIDDEN_ATTRS:
        raise PermissionError(...)
    self.generic_visit(node)
```

The visitor correctly blocks `__dunder__` attributes and known dangerous names, but it **does not block dynamic attribute access** via patterns like:
```python
getattr(pd, "read_" + "csv")  # bypasses static AST check
```

`getattr` itself is already blocked in `BLOCKED_BUILTINS` — this specific bypass is mitigated. However, the sandbox remains **shallow by design**. There is no `seccomp`, `AppArmor`, or full process-level isolation (beyond `multiprocessing`). This is an architectural note, not a quick fix.

**Action:** Add a comment in the code making this boundary explicit so future developers don't assume it's a full security sandbox:
```python
# SECURITY NOTE: This is a best-effort sandbox, not a full isolation boundary.
# multiprocessing provides OS-level process isolation for CPU/memory, but the
# Python environment is not hardened against determined adversaries.
# Do not expose this to untrusted public users without additional controls.
```

---

### 11. `_get_user_state()` calls `enforce_session_limit` unconditionally on routes that don't need it

**File:** [`server.py:143–154`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py#L143)

```python
def _get_user_state():
    state = session_mgr.get_state(g.user_id)
    usage_service.ensure_usage_state(state)
    if not getattr(state, "chat_sessions", None):
        chat_session_service.ensure_active_session(...)
    chat_session_service.enforce_session_limit(state, app_config.MAX_CHAT_SESSIONS)  # runs for every route
    return state
```

Routes like `/api/files`, `/api/data-summary/<filename>`, `/api/usage/summary` call `_get_user_state()` and trigger `enforce_session_limit()` even though they never modify or even read session data. The iterating + sorting cost is O(n) over active sessions and adds latency to every API request.

**Fix:** Extract a leaner `_get_base_state()` (without session enforcing) for read-only routes, and keep `_get_user_state()` for routes that interact with chat sessions.

---

### 12. Supabase dashboard read fetches the full `config` JSONB on every cache miss

**File:** [`src/services/dashboard_store.py:89–91`](file:///c:/Users/DAVID/Desktop/DataTalk/src/services/dashboard_store.py#L89)

```python
result = sb_service.table("dashboard_configs").select("config").eq("user_id", user_id).execute()
```

The in-memory TTL cache (`DASHBOARD_STORE_CACHE_TTL_SECONDS = 120`) partially mitigates this. However, on the first request after a cache miss (or for new users), the full `config` JSONB column is transferred regardless of how many sessions' worth of data it contains. For dashboards with many pinned charts this payload grows unboundedly.

**Pragmatic improvement:** Cache aggressively on write by storing the written payload immediately (already done in `save_dashboard_store`). The current implementation does this correctly. The residual issue is that simultaneous requests from separate sessions share no cache — each user has their own state cache which is correct, but server restarts flush all in-memory caches requiring a fresh Supabase read for every re-authenticated user.

**Longer-term fix:** Implement a Redis-backed shared cache or use Supabase RPC to return only the session-specific slice.

---

### 13. `_build_chat_session_payload()` and `_build_chat_history_snapshot()` both call `_get_active_session()`

**File:** [`server.py:177–202`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py#L177)

```python
def _build_chat_session_payload(state):
    chat_session_service.enforce_session_limit(...)  # ← session resolution #1
    active_session = _get_active_session(state)       # ← _ensure_active_session call #1
    ...

def _build_chat_history_snapshot(state):
    active_session = _get_active_session(state)       # ← _ensure_active_session call #2
    payload = chat_session_service.build_persisted_payload(state)
```

When these are called back-to-back (e.g., in chat routes: `_save_chat_history` → `_build_chat_history_snapshot` then `_build_chat_session_payload`), `ensure_active_session()` runs twice for the same state. It's idempotent, so no bug — but it adds redundant iteration.

---

## 🗑️ Dead / Redundant Code

| # | Location | What to Remove |
|---|---|---|
| D1 | `code_executor.py:192–194` | Three lines of dead code after an unconditional `raise RuntimeError(...)` — `tb` and `err` are undefined here and these lines are never reached |
| D2 | `auth_service.py:284` | `sb.auth._headers.update(...)` — the fresh client is mutated but `sign_out()` is never called; the entire function body is effectively no-op dead code |
| D3 | `server.py:627–628` | `_is_empty_row()` inner function — move to module scope or inline |
| D4 | `js/data-chat.js:796–798` | Redundant `if (!path)` — always true when reached; simplify to `else` |

---

## ♻️ Refactor / Code Reduction Opportunities

### R1. Split `server.py` into Flask Blueprints — the #1 quality improvement remaining

**File:** [`server.py`](file:///c:/Users/DAVID/Desktop/DataTalk/server.py) — 1,219 lines

The project now has a clean, fully tested service layer. The remaining obstacle to maintainability is `server.py` itself — every route (auth, data, chat, dashboard) still lives in one file. The Blueprint pattern is already used in many Flask projects of this scale.

| Blueprint | Routes | Estimated Lines |
|---|---|---|
| `auth_bp` | `/api/auth/*`, `/api/profile` | ~100 |
| `data_bp` | `/api/upload`, `/api/files`, `/api/data/*`, `/api/suggest-questions` | ~170 |
| `chat_bp` | `/api/chat`, `/api/chat/*`, `/api/usage/summary` | ~320 |
| `dashboard_bp` | `/api/dashboard*` | ~170 |
| `server.py` (init only) | Flask setup, static serving, shared helpers | ~150 |

This reduces `server.py` from 1,219 → ~150 lines (88% reduction).

---

### R2. Extract a `_get_base_state()` for read-only routes

Currently `_get_user_state()` runs `enforce_session_limit()` for every authenticated request, including read-only routes (`/api/files`, `/api/data-summary`, `/api/usage/summary`). Splitting into:

```python
def _get_base_state():
    """Lightweight state fetch for read-only routes."""
    state = session_mgr.get_state(g.user_id)
    usage_service.ensure_usage_state(state)
    return state

def _get_user_state():
    """Full state fetch with session enforcement for write routes."""
    state = _get_base_state()
    if not getattr(state, "chat_sessions", None):
        chat_session_service.ensure_active_session(state, ...)
    chat_session_service.enforce_session_limit(state, app_config.MAX_CHAT_SESSIONS)
    return state
```

Routes like `list_uploaded_files`, `data_summary`, `get_full_data`, and `get_usage_summary` can safely call `_get_base_state()`.

---

### R3. `usage_service` rate-limit window pops entries on both read AND write

**File:** [`src/services/usage_service.py:117–125`](file:///c:/Users/DAVID/Desktop/DataTalk/src/services/usage_service.py#L117) and [`128–135`](file:///c:/Users/DAVID/Desktop/DataTalk/src/services/usage_service.py#L128)

```python
def record_message_request(state, rate_limit, now_ts=None):
    ...
    while state.message_request_times and state.message_request_times[0] < cutoff:
        state.message_request_times.popleft()   # eviction #1

def get_request_budget(state, rate_limit, now_ts=None):
    ...
    while state.message_request_times and state.message_request_times[0] < cutoff:
        state.message_request_times.popleft()   # eviction #2 — same logic
```

The same expired-entry eviction loop is duplicated across both functions. Extract a private `_evict_expired_requests(state, cutoff)` helper to remove the duplication.

```python
def _evict_expired_requests(state, cutoff: float) -> None:
    while state.message_request_times and state.message_request_times[0] < cutoff:
        state.message_request_times.popleft()
```

---

## Quick Wins Summary (do these first)

Priority order by impact vs. effort:

1. **🔴 Fix `logout()`** — call `sb.auth.admin.sign_out(access_token)` correctly; users are not being signed out server-side
2. **🔴 Delete dead code** in `code_executor.py:192–194` — remove 3 lines, eliminates `NameError` risk
3. **🟠 Fix `MODEL_ID` default** — change `"gemini-3.1-flash-lite-preview"` → `"gemini-2.0-flash-lite"`; currently any deployment without `.env` fails immediately
4. **🟠 Register `atexit` executor shutdown** — one line prevents write-loss on server crash
5. **🟠 Add `.limit(1)` comment** in `_load_chat_history_for_user()` — prevents future schema migration bugs
6. **🟠 Fix `clear_chat` usage reset** — delegate to `usage_service` instead of inline struct literal
7. **🟡 Fix `syncActiveSessionFile()` redundant branch** — trivial 2-line JS refactor
8. **♻️ Extract `_evict_expired_requests()` helper** in `usage_service.py` — de-dup 4 lines
9. **♻️ Add sandbox disclaimer comment** in `code_executor.py` — zero-risk documentation
10. **♻️ Begin Blueprint split** — the highest-leverage structural improvement: `server.py` 1,219 → ~150 lines

---

## Architecture Notes (for planning)

### What the refactor got right

- **Service layer is clean.** Each service (`auth_service`, `chat_session_service`, `usage_service`, `data_service`, `dashboard_store`, `analysis_pipeline`) has a clear, narrow responsibility.
- **Error hierarchy is consistent.** `DataTalkError` subclasses are used correctly throughout, and the global error handler in `server.py` cleanly converts them to JSON.
- **`_extract_usage_dict()` centralisation.** Consolidated into `gemini_service.py` — all four call sites now use the same safe implementation.
- **`multiprocessing` sandbox.** The upgrade from `threading.Thread` to `multiprocessing.Process` is the correct solution for enforcing execution timeouts.
- **`_activate_file()` helper.** The repeated pattern of `ensure_active_session + set filename` is now one call.
- **Pagination moved to core.** `src/core/pagination.py` is the right home for `paginate()`.
- **`resolve_requested_session_id` moved to service layer.** Now lives in `chat_session_service.py`, correctly scoped.

### Remaining architectural debt

- `server.py` is still a monolith (1,219 lines). Flask Blueprints exist precisely for this.
- Rate-limiting is tracked in-memory per-process. On multi-worker deployments (Gunicorn, uWSGI) each worker has its own `message_request_times` deque — a user could exceed the limit simply by hitting different workers. Flask-Limiter's `storage_uri="memory://"` has the same problem. **Fix:** Switch `storage_uri` to Redis for multi-process correctness.
- Session state (`SessionManager`) is also in-memory and per-process. Same multi-worker issue — a user authenticated by worker A has no session in worker B.

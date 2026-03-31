---
name: DATA TALK
description: Comprehensive guide for understanding and contributing to the Data Talk AI-powered data analysis web application.
---

# Data Talk — AI-Powered Data Analysis Platform

## Project Overview

**Data Talk** is a multi-user web-based data analysis application that allows users to upload CSV/Excel files and interact with a Google Gemini LLM to ask natural language questions about their data. The LLM generates Python code that is executed in a sandboxed environment against the full dataset, producing interactive charts, tables, statistics, and natural language explanations. Results stream in real-time via SSE.

### Key Capabilities
- **Authentication**: Supabase Auth with email/password signup, JWT-protected API routes
- **File Upload**: CSV/Excel files uploaded to Supabase Storage with per-user isolation
- **AI Chat Analysis**: Natural language questions answered via a multi-phase code generation + execution pipeline
- **SSE Streaming**: Real-time pipeline progress updates (extracting, generating, executing, interpreting)
- **Interactive Charts**: Plotly.js charts with annotations, download, pin-to-dashboard, and fullscreen
- **Dashboard**: Drag-and-drop visualization grid with column resizing, persisted to Supabase
- **Theme**: Single light-theme visual system using shared CSS variables
- **Session Persistence**: Chat history, dashboard configs, and user profiles stored in Supabase PostgreSQL

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                  │
│  Vanilla HTML / JS / CSS (no framework, no bundler)               │
│  dashboard.html  +  js/core.js  +  js/data-chat.js               │
│                  +  js/dashboard-ui.js  +  js/constants.js        │
│  Views: Data Connector | Chat Analysis | Visualisations           │
└─────────────────────────┬────────────────────────────────────────┘
                          │ REST API + SSE (fetch with Bearer JWT)
┌─────────────────────────▼────────────────────────────────────────┐
│                    BACKEND (Flask)                                 │
│  server.py — Port 5000 (configurable)                             │
│  Endpoints: /api/auth/*, /api/upload, /api/chat/stream,           │
│             /api/dashboard/*, /api/suggest-questions, etc.         │
├──────────────────────────────────────────────────────────────────┤
│  gemini_service.py    — Gemini API integration & LLM prompts      │
│  data_service.py      — Supabase Storage, data profiling, schema  │
│  code_executor.py     — Sandboxed Python code execution (AST)     │
│  auth_service.py      — Supabase Auth, JWT, @require_auth         │
│  app_state.py         — Per-user SessionManager + QueryCache      │
│  app_config.py        — Centralized env config + constants        │
└─────────────────────────┬────────────────────────────────────────┘
                          │
┌─────────────────────────▼────────────────────────────────────────┐
│                  EXTERNAL SERVICES                                 │
│  Google Gemini (gemini-3.1-flash-lite-preview) — LLM              │
│  Supabase — Auth + Storage (files) + PostgreSQL (profiles,        │
│             chat_sessions, dashboard_configs with RLS)             │
└──────────────────────────────────────────────────────────────────┘
```

---

## File Reference

### Backend (Python)

| File | Lines | Purpose |
|---|---|---|
| `server.py` | ~997 | Flask API server. Serves static files, REST + SSE endpoints. Entry point: `python server.py`. All `/api/*` data routes protected by `@require_auth`. Contains both non-streaming (`/api/chat`) and streaming (`/api/chat/stream`) pipelines. |
| `gemini_service.py` | ~435 | All Google Gemini API interactions. Contains 3 prompts (`SYSTEM_PROMPT`, `CODE_GEN_PROMPT`, `EXTRACTION_PROMPT`), code generation, interpretation, retry, and fallback functions. Uses `google-genai` SDK. |
| `data_service.py` | ~454 | Supabase Storage file management (upload, download, list). DataFrame summarization, schema generation (`get_schema_string`), data profiling (`get_data_profile`), column cleaning. |
| `code_executor.py` | ~317 | Sandboxed execution of LLM-generated Python code. AST validation via `_SafetyVisitor`, 19 blocked builtins, 9 forbidden modules, 14 forbidden attributes, subprocess isolation via `multiprocessing.spawn`, 60s timeout. |
| `auth_service.py` | ~195 | Supabase Auth integration: signup, login, logout, JWT verification via `getUser()`, profile fetch. Provides `@require_auth` Flask decorator that sets `g.user_id` and `g.user_email`. |
| `app_state.py` | ~92 | Per-user state management. `SessionManager` (thread-safe) creates `UserState` per `user_id`. `UserState` holds `chat_histories`, `active_file`, `query_cache` (bounded LRU), and `_file_cache` (DataFrame + schema + profile caching). |
| `app_config.py` | ~61 | Centralized environment variable parsing. All magic numbers configurable: `PORT`, `MAX_UPLOAD_MB`, `MAX_RETRIES`, `CHAT_HISTORY_CAP`, `QUERY_CACHE_SIZE`, `EXEC_TIMEOUT`, Supabase credentials, SSL paths. |

### Frontend

| File | Lines | Purpose |
|---|---|---|
| `dashboard.html` | ~264 | Main SPA shell. Sidebar navigation (3 views), top bar (title, user profile), content area (upload zone, chat, dashboard grid), fullscreen modal. Loads 6 CDN libraries. |
| `js/constants.js` | ~13 | Frontend configuration constants: chart heights, render timeouts, resize delays. |
| `js/core.js` | ~389 | App singleton (`App`): auth state, JWT headers, session validation, sign-out, user profile. Utilities: `escapeHtml()`, `sanitizeHtml()` (DOMPurify), `renderMarkdown()` (Marked.js). Particle canvas animation. DOM initialization, view switching. |
| `js/data-chat.js` | ~734 | File upload flow (client-side 10MB validation, FormData POST, Handsontable grid). SSE chat streaming (manual `ReadableStream` parsing, not `EventSource`). Chart rendering (`mountPlotlyChart`), typing indicators, suggestion chips, chat history, annotations, regenerate. |
| `js/dashboard-ui.js` | ~479 | Dashboard chart pinning, visualization grid, HTML5 drag-and-drop reordering, column-span resizing (1/2/3 cols), fullscreen modal with focus trap + Escape key, chart download (PNG), smart question fetching, data preview panel. |
| `index.html` | ~67 | Marketing landing page with particle canvas background. |
| `login.html` | ~332 | Supabase Auth page — sign in/sign up toggle, inline styles + scripts, token storage in localStorage. |
| `script.js` | ~16 | Legacy backward-compatibility script loader (dynamically loads `core.js`, `data-chat.js`, `dashboard-ui.js`). |

### Stylesheets

| File | Lines | Purpose |
|---|---|---|
| `styles.css` | ~566 | Global styles, CSS custom properties (`:root`), landing page, buttons, hero, responsive breakpoint (768px), suggestion chips. |
| `dashboard.css` | ~6 | CSS `@import` manifest for the 4 dashboard stylesheets below. |
| `css/dashboard-layout.css` | ~206 | Dashboard structure: sidebar (260px), top bar, content area, nav items, user profile pill, Handsontable light-mode override. |
| `css/dashboard-chat.css` | ~340 | Chat messages, avatars, typing indicator (bouncing dots), input bar (glassmorphism), code blocks, chart containers, suggestion chips. |
| `css/dashboard-grid.css` | ~227 | Visualization grid (CSS Grid, 3-column), chart cards, drag-and-drop states, resize controls, empty state. |
| `css/dashboard-overlays.css` | ~467 | Upload banner, data preview panel, fullscreen modal, stats cards, data tables, follow-up chips, error banners, annotations, streaming text animation. |

### Configuration & Infrastructure

| File | Purpose |
|---|---|
| `requirements.txt` | 10 Python packages, all pinned to exact versions. |
| `start.bat` | Windows launcher: Python check, `pip install`, server start, browser open. |
| `.env` | `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `HTTPS_ENABLED`. |
| `.gitignore` | Covers `__pycache__/`, `.env`, `uploads/`, `certs/`, `node_modules/`, etc. |

---

## Multi-Step Analysis Pipeline

The chat endpoints (`POST /api/chat` and `POST /api/chat/stream`) use a sophisticated multi-step pipeline:

### Phase 0.5 — Data Extraction (Lean Schema)
1. Build a **Lean Schema** using `data_service.get_schema_string(df, max_tokens=2000)` — column names, types, and 5 sample rows.
2. Send to `gemini_service.generate_data_extraction_code()` — LLM writes Python code to extract unique values from relevant columns.
3. Execute extraction code via `code_executor.execute_extraction_code()`.
4. Result: a JSON dict of unique values per column (e.g., `{"Country": {"US": 150, "UK": 80}}`).

### Phase 1 — Code Generation (Full Schema)
1. Build a **Full Schema** using `data_service.get_schema_string(df, max_tokens=15000)` — metadata, distributions, correlations, and dynamically-fitted sample rows.
2. Build a **Data Profile** via `data_service.get_data_profile(df)` — auto-detected dataset type and column roles.
3. Send to `gemini_service.generate_analysis_code()` with extracted data context from Phase 0.5, profile context, and capped chat history.
4. Execute generated Python code against the **full DataFrame** via `code_executor.execute_analysis_code()`.
5. On failure, retry up to `MAX_RETRIES` (default 2) times via `gemini_service.retry_analysis_code()` with error feedback.

### Phase 2 — Interpretation
1. Send execution results back to `gemini_service.interpret_results()`.
2. LLM generates a natural language explanation of the computed results.

### Phase 3 — Fallback
If code generation/execution fails entirely after all retries, fall back to `gemini_service.analyze_data()` which sends a text summary of the data directly to Gemini for a text-only response.

### Caching Strategy
- **DataFrame caching**: `_get_dataframe()` in `server.py` checks `UserState._file_cache` before downloading from Supabase. Invalidated on new upload via `clear_file_cache()`.
- **Schema/profile caching**: `schema_lean`, `schema_full`, and `profile` are cached per file in `UserState._file_cache`. Invalidated together with DataFrame on upload.
- **Query caching**: `QueryCache` (bounded LRU, default 300 items) keyed by MD5 of `(filename, message)`. Per-user, thread-safe.

---

## Token Optimization Strategy

| Strategy | Details |
|---|---|
| **Lean Schema** | Phase 0.5 uses `max_tokens=2000` (just metadata + 5 rows). Cost: ~1,500-3,000 tokens. |
| **Full Schema** | Phase 1 uses `max_tokens=15000` with dynamic CSV packing (fills remaining budget with rows). |
| **History Capping** | Only the last `CHAT_HISTORY_CAP` messages (default 5) are sent to the LLM. |
| **Token Logging** | All LLM calls log token usage via structured `_log_event()`. |
| **Programmatic Extraction** | Instead of sending raw data, the LLM writes code to extract unique values, avoiding massive context windows. Top 500 values per column with an "Other" bucket. |
| **Schema Caching** | Lean schema, full schema, and data profile are computed once per file and cached in `UserState._file_cache`. |

---

## Key Conventions

### Authentication (`auth_service.py`)

- **Supabase Auth**: Email/password signup and login.
- **Two clients**: `get_supabase()` (anon key, for auth operations) and `get_supabase_service()` (service role key, bypasses RLS for profile/data queries).
- **JWT verification**: `verify_token(access_token)` calls Supabase `auth.get_user()` on every request. No local JWT caching.
- **`@require_auth` decorator**: Verifies `Authorization: Bearer <token>` header. Sets `g.user_id` and `g.user_email` on success. Returns 401 on failure.
- **Token storage (frontend)**: `dt_access_token`, `dt_refresh_token`, `dt_user` in `localStorage`.

### Gemini Service (`gemini_service.py`)

- **Model**: Defined in `MODEL_ID` constant (default `gemini-3.1-flash-lite-preview`, overridable via `GEMINI_MODEL_ID` env var).
- **Client**: Uses `google-genai` SDK (`genai.Client`), NOT the deprecated `google-generativeai`.
- **All LLM functions return a tuple**: `(result, usage_metadata)` where `usage_metadata` is `{"input_tokens": N, "output_tokens": N, "total_tokens": N}`.
- **3 main prompts**:
  - `SYSTEM_PROMPT` — For text-based fallback analysis (`analyze_data`). Expects JSON response.
  - `CODE_GEN_PROMPT` — For Python code generation (`generate_analysis_code`). Expects raw Python.
  - `EXTRACTION_PROMPT` — For data extraction code (`generate_data_extraction_code`). Expects raw Python.
- **Safety in prompts**: `CODE_GEN_PROMPT` includes explicit instructions to check empty DataFrames before `.iloc[0]` and to avoid `.iterrows()`, `.apply()`, and manual for-loops.
- **Code cleaning**: `_call_llm_for_code()` strips markdown fences and returns raw Python code.
- **Response parsing**: `_parse_response()` handles JSON, JSON-in-code-fences, JSON-embedded-in-text, and plain text fallback.

### Data Service (`data_service.py`)

- **Storage**: Files uploaded to Supabase Storage bucket `"datasets"` at path `{user_id}/{filename}`.
- **Column name cleaning**: `clean_column_names(df)` removes newlines/tabs. Called automatically in `get_schema_string()` and `get_data_profile()`.
- **`get_schema_string(df, max_tokens=15000)`**: Generates structured text context with:
  - Section 1: Overview (rows x columns)
  - Section 2: Column metadata (dtype, unique count, nulls, top values or numeric stats)
  - Section 3: Correlations (only if `max_tokens >= 5000`)
  - Section 4: Sample rows (lean mode: 5 rows; full mode: dynamic CSV packing within char budget)
- **`get_data_profile(df)`**: Auto-detects dataset type (`survey`, `time_series`, `transactional`, `categorical`, `numerical`, `general`) and column roles (`timestamp`, `measure`, `category`, `binary`, `ordinal`, `id`, `free_text`). Generates domain-specific analysis suggestions.
- **`_to_native(val)`**: Converts numpy/pandas types to native Python for JSON serialization.

### Code Executor (`code_executor.py`)

- **Sandboxed environment**: Only `pd` (pandas), `np` (numpy), `json`, and `math` are available.
- **5-layer security**:
  1. Code length cap: 10,000 characters max
  2. AST validation via `_SafetyVisitor` (blocks imports, forbidden names, forbidden attributes)
  3. 19 blocked builtins (open, eval, exec, compile, __import__, globals, locals, getattr, setattr, delattr, breakpoint, exit, quit, input, memoryview, classmethod, staticmethod, property, super)
  4. Subprocess isolation via `multiprocessing.get_context("spawn")`
  5. Configurable timeout (default 60s) with process termination
- **Expected output**: Code must produce a `result` dict with keys: `text`, `chart` (Plotly JSON or None), `table` (DataFrame or headers/rows or None), `stats` (list of stat cards or None), `followup` (list of follow-up questions).
- **`execute_analysis_code(code_string, df)`**: For Phase 1 analysis code. Returns normalized result.
- **`execute_extraction_code(code_string, df)`**: For Phase 0.5 extraction code. Returns arbitrary dict.
- **`_normalize_table(table)`**: Converts pandas DataFrames to `{"headers": [...], "rows": [[...]]}` format.
- **`_deep_convert(obj)`**: Recursively converts numpy/pandas types to native Python (int, float, str, None).

### State Management (`app_state.py`)

- **`SessionManager`**: Thread-safe (via `threading.Lock`). Creates one `UserState` per `user_id`.
- **`UserState`**: Per-user container holding:
  - `chat_histories`: `dict[str, list]` — keyed by session_id
  - `active_file`: `{"filename": str | None}`
  - `query_cache`: `QueryCache` instance (bounded LRU, default 300 items, thread-safe)
  - `_file_cache`: `dict[str, dict]` — caches `"df"`, `"schema_lean"`, `"schema_full"`, `"profile"` per filename
- **Cache invalidation**: `clear_file_cache()` called on new upload and on chat clear.

### Server (`server.py`)

- **Port**: Configurable via `PORT` env var (default 5000).
- **CORS**: Restricted to configured origins (defaults to localhost).
- **Static file serving**: Whitelist-based (`ALLOWED_STATIC_FILES` + `ALLOWED_STATIC_PREFIXES`).
- **Structured logging**: `_log_event(event, **fields)` emits JSON-formatted log lines.
- **HTTPS support**: Optional self-signed cert generation via `HTTPS_ENABLED=true`.
- **SSE streaming**: `/api/chat/stream` uses `Response(stream_with_context(generate()), mimetype="text/event-stream")` with events: `phase`, `result`, `error`, `done`.

### Frontend (`js/*.js` + `dashboard.html`)

- **No framework or bundler**: Vanilla JS with global functions on `window`. Load order: `constants.js` → `core.js` → `data-chat.js` → `dashboard-ui.js`.
- **`App` singleton**: Global object managing auth state, JWT headers, theme, user profile.
- **API calls**: All use `fetch()` with `App.getAuthHeaders()` (returns `{Authorization: "Bearer <token>"}`).
- **CDN libraries** (loaded in `dashboard.html`):
  - Plotly.js 2.35.0 — Chart rendering
  - Handsontable (latest, `non-commercial-and-evaluation` license) — Spreadsheet grid
  - SheetJS xlsx (latest) — Client-side Excel parsing
  - Marked.js (latest) — Markdown rendering
  - DOMPurify 3.2.6 — HTML sanitization
- **View system**: Three views switched via `switchView(viewName)`: `data`, `chat`, `visuals`.
- **Chat flow**: `sendMessage()` → SSE stream via `ReadableStream` → `appendChatMessage()` with chart/table/stats/followup rendering.
- **Chart actions**: Pin to Dashboard, Download PNG, Expand Fullscreen, Annotate (click-to-label).
- **Smart questions**: Fetched from `/api/suggest-questions` after file upload, displayed as chips.
- **Particle background**: Canvas-based animated particle effect on landing and dashboard pages.

---

## REST API Endpoints

### Authentication (no JWT required)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/signup` | Register new user (email, password, display_name) |
| `POST` | `/api/auth/login` | Authenticate user, returns JWT tokens |
| `POST` | `/api/auth/logout` | Sign out user (invalidates refresh token) |
| `GET` | `/api/auth/session` | Validate existing JWT, returns user + profile |

### Data (JWT required — `@require_auth`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload CSV/Excel file to Supabase Storage |
| `GET` | `/api/files` | List uploaded files for current user |
| `GET` | `/api/data-summary/<filename>` | Get summary stats for a file |
| `GET` | `/api/data/<filename>` | Get full dataset as JSON (columns + rows) |
| `GET` | `/api/suggest-questions` | Get 4 AI-generated question suggestions |

### Chat (JWT required — `@require_auth`)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/chat` | Send message for AI analysis (non-streaming, JSON response) |
| `POST` | `/api/chat/stream` | Send message for AI analysis (SSE streaming) |
| `GET` | `/api/chat/history` | Get persisted chat history from Supabase |
| `POST` | `/api/chat/clear` | Clear chat history + active file + caches |

### Dashboard (JWT required — `@require_auth`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/dashboard` | Get dashboard config from Supabase |
| `POST` | `/api/dashboard` | Save full dashboard config |
| `POST` | `/api/dashboard/pin` | Pin a single chart to dashboard |
| `DELETE` | `/api/dashboard/remove/<chart_id>` | Remove a pinned chart |

---

## Supabase Database Schema

### Tables

| Table | Purpose | RLS |
|---|---|---|
| `profiles` | User display name, avatar initials. Auto-created via trigger on auth signup. | Yes, per-user |
| `chat_sessions` | Persisted chat history per user (JSON blob). | Yes, per-user |
| `dashboard_configs` | Dashboard chart configurations per user (JSON blob). | Yes, per-user |

### Storage

| Bucket | Purpose |
|---|---|
| `datasets` | User-uploaded CSV/Excel files. Path: `{user_id}/{filename}`. |

---

## Design System

- **Font**: `Inter` (Google Fonts), fallback `sans-serif`.
- **Primary Color**: `#4285f4` (Google Blue).
- **Chart Color Palette**: `["#4285f4", "#ea4335", "#fbbc05", "#34a853", "#ff6d01", "#46bdc6", "#7b1fa2", "#c2185b"]`.
- **Chart Template**: `plotly_white` with `font.family = "Inter, sans-serif"`.
- **Donut Charts**: Use `hole: 0.4`.
- **CSS Variables** (defined in `styles.css` `:root`): `--primary-color`, `--text-color`, `--text-light`, `--border-color`, `--bg-gradient`, `--surface`, `--surface-hover`, `--card-bg`, `--shadow`, `--font-family`.
- **Theme**: A single light theme powered by shared CSS variables.
- **Glassmorphism**: Sidebar and input bar use `backdrop-filter: blur()` with semi-transparent backgrounds.

---

## Running the Application

### Quick Start (Windows)
```batch
cd "c:\Users\DAVID\Desktop\Data Talk"
start.bat
```

### Manual Start
```bash
python server.py
# Open browser to http://localhost:5000
```

### Prerequisites
- Python 3.10+
- `.env` file with:
  - `GEMINI_API_KEY` — Google Gemini API key
  - `SUPABASE_URL` — Supabase project URL
  - `SUPABASE_ANON_KEY` — Supabase anon/public key
  - `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (for RLS bypass)
- Dependencies: `pip install -r requirements.txt`

### Optional Environment Variables
| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | Flask server port |
| `FLASK_DEBUG` | `false` | Enable Flask debug mode |
| `HTTPS_ENABLED` | `false` | Enable HTTPS with self-signed certs |
| `MAX_UPLOAD_MB` | `10` | Max file upload size in MB |
| `MAX_RETRIES` | `2` | Code generation retry attempts |
| `CHAT_HISTORY_CAP` | `5` | Max messages sent to LLM |
| `QUERY_CACHE_SIZE` | `300` | LRU cache max items per user |
| `EXEC_TIMEOUT` | `60` | Code execution timeout in seconds |
| `GEMINI_MODEL_ID` | `gemini-3.1-flash-lite-preview` | Gemini model to use |
| `CORS_ALLOWED_ORIGINS` | `localhost` | Comma-separated allowed origins |
| `SSL_CERT_PATH` | `certs/cert.pem` | SSL certificate path |
| `SSL_KEY_PATH` | `certs/key.pem` | SSL private key path |

---

## Common Modification Patterns

### Adding a New Analysis Feature
1. Add/modify the prompt in `gemini_service.py` (e.g., update `CODE_GEN_PROMPT`).
2. If new execution logic is needed, update `code_executor.py`.
3. Wire it into `server.py` — update BOTH `chat()` and `chat_stream()` (they share the same pipeline logic).
4. Update `js/data-chat.js` to handle new response fields in `appendChatMessage()`.

### Changing the LLM Model
1. Set `GEMINI_MODEL_ID` env var in `.env`, OR update the default in `gemini_service.py` line 21.
2. No other changes needed — all functions reference the `MODEL_ID` constant.

### Adjusting Token Budgets
1. **Phase 0.5 (Extraction)**: Change `max_tokens=2000` in `server.py` schema calls within `chat()` and `chat_stream()`.
2. **Phase 1 (Analysis)**: Change `max_tokens=15000` in `server.py` schema calls.
3. **History cap**: Set `CHAT_HISTORY_CAP` env var or change default in `app_config.py`.

### Adding a New API Endpoint
1. Add the Flask route in `server.py` with `@require_auth` decorator.
2. Access user state via `_get_user_state()` (returns `UserState` for `g.user_id`).
3. Add the frontend `fetch()` call with `App.getAuthHeaders()` in the appropriate JS file.
4. Add any UI elements in `dashboard.html`.

### Adding a New Cached Computation
1. In `server.py`, use the pattern:
   ```python
   value = state.get_cached(filename, "your_key")
   if value is None:
       value = compute_expensive_thing(df)
       state.set_cached(filename, "your_key", value)
   ```
2. The cache is automatically invalidated on new upload (`clear_file_cache()` in `upload_file()`).

---

## Debugging Tips

- **Structured logs**: All events logged as JSON via `_log_event()`. Look for event types: `file_uploaded`, `dataframe_cache_hit`, `dataframe_cache_miss`, `profile_detected`, `extraction_*`, `code_gen_*`, `execution_*`, `interpretation_*`, `chat_*`.
- **Token usage**: LLM calls log `input_tokens`, `output_tokens`, `total_tokens` in event payloads.
- **SSE debugging**: Open browser DevTools Network tab, filter by `EventStream` type. Events: `phase` (progress), `result` (final JSON), `error` (failure), `done` (stream end).
- **Common errors**:
  - `NoneType.__format__`: Usually caused by `NaN` values in numeric stats — handled by `_to_native()` and `_fmt()` in `data_service.py`.
  - `IndexError: index 0 is out of bounds`: LLM code accessing empty DataFrames — mitigated by safety instructions in `CODE_GEN_PROMPT`.
  - `Code execution timed out`: Subprocess exceeded `EXEC_TIMEOUT`. The LLM likely generated an O(n^2) loop — retry usually produces optimized code.
  - `Missing or invalid Authorization header`: Frontend not sending JWT. Check `localStorage` for `dt_access_token`.
  - `Invalid or expired token`: JWT expired. No refresh endpoint exists yet — user must re-login.
- **Flask debug mode**: Enable via `FLASK_DEBUG=true` in `.env` for auto-reload on file changes.

---

## Known Limitations

- **Dual chat pipeline**: `chat()` and `chat_stream()` duplicate ~360 lines of pipeline logic. Changes must be applied in both.
- **No rate limiting**: Chat and suggestion endpoints can be abused with rapid requests.
- **No token refresh**: Expired JWTs require re-authentication (no `/api/auth/refresh` endpoint).
- **Token verified via network**: Every request calls Supabase `getUser()` API — no local JWT validation.
- **Desktop-only UI**: No responsive design for the dashboard. Sidebar is fixed 260px, grid is always 3 columns.
- **File types**: Only CSV, XLS, XLSX are supported.
- **No data pagination**: Full dataset sent as JSON to frontend — large files cause memory pressure.
- **CDN dependencies without SRI**: 6 external libraries loaded without Subresource Integrity hashes.
- **Subprocess per query**: A new Python process is spawned for every chat query — adds 0.5-1s overhead.

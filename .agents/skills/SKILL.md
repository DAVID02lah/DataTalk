---
name: Data Talk Project
description: Comprehensive guide for understanding and contributing to the Data Talk AI-powered data analysis web application.
---

# Data Talk — AI-Powered Data Analysis Platform

## Project Overview

**Data Talk** is a web-based data analysis application that allows users to upload CSV/Excel files and interact with a Google Gemini LLM to ask natural language questions about their data. The LLM generates Python code that is executed in a sandboxed environment against the full dataset, producing charts, tables, statistics, and natural language explanations.

### Key Capabilities
- Upload CSV/Excel files and preview them in a spreadsheet grid
- Ask natural language questions about the data (e.g., "Show me sales by region")
- AI generates and executes Python code to analyze the full dataset
- Produces interactive Plotly charts, summary tables, and stat cards
- Charts can be pinned to a PowerBI-like dashboard (Streamlit)
- Multi-step extraction pipeline for handling noisy/dirty data
- Token-optimized LLM interactions with monitoring

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                             │
│  dashboard.html  +  script.js  +  styles.css                │
│  (Single-page app with sidebar navigation)                  │
│  Views: Data Connector | Chat Analysis | Visualisations     │
└──────────────────────┬──────────────────────────────────────┘
                       │ REST API (fetch)
┌──────────────────────▼──────────────────────────────────────┐
│                   BACKEND (Flask)                            │
│  server.py — Port 5000                                      │
│  Endpoints: /api/upload, /api/chat, /api/dashboard, etc.    │
├─────────────────────────────────────────────────────────────┤
│  gemini_service.py    — Gemini API integration & prompts    │
│  data_service.py      — Data loading, profiling, schema     │
│  code_executor.py     — Sandboxed Python code execution     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│              STREAMLIT DASHBOARD                             │
│  streamlit_app.py — Port 8501                               │
│  Renders pinned charts in a PowerBI-style grid              │
│  Embedded in dashboard.html via iframe                      │
└─────────────────────────────────────────────────────────────┘
```

---

## File Reference

### Backend (Python)

| File | Purpose |
|---|---|
| `server.py` | Flask API server. Serves static files and all REST endpoints. Entry point: `python server.py` (port 5000). |
| `gemini_service.py` | All Google Gemini API interactions. Contains prompts, code generation, interpretation, and extraction functions. Uses `google-genai` SDK. |
| `data_service.py` | Data loading (CSV/Excel), summarization, schema generation, data profiling, and column cleaning utilities. |
| `code_executor.py` | Sandboxed execution of LLM-generated Python code. Only `pandas`, `numpy`, and `json` are available. Dangerous builtins are blocked. |
| `streamlit_app.py` | Streamlit dashboard for rendering pinned Plotly charts in a responsive grid. Runs on port 8501. |

### Frontend

| File | Purpose |
|---|---|
| `dashboard.html` | Main single-page application. Contains all HTML structure, inline CSS for components, and references to `script.js` and `styles.css`. |
| `script.js` | All frontend JavaScript logic: file upload, chat messaging, chart rendering (Plotly), dashboard pinning, view switching, smart question chips. |
| `styles.css` | Shared CSS design system with CSS variables, typography, and base styles. |
| `index.html` | Landing/redirect page. |
| `login.html` | Login page (not integrated into main flow). |

### Configuration & Startup

| File | Purpose |
|---|---|
| `start.bat` | Windows batch script to install dependencies, start Flask (port 5000), start Streamlit (port 8501), and open the browser. |
| `requirements.txt` | Python dependencies: `flask`, `flask-cors`, `google-genai`, `pandas`, `openpyxl`, `plotly`, `streamlit`, `streamlit-elements`, `python-dotenv`. |
| `.env` | Contains `GEMINI_API_KEY`. Loaded by `python-dotenv` in `gemini_service.py`. |

### Data Storage

| Path | Purpose |
|---|---|
| `uploads/` | Uploaded CSV/Excel files are saved here. |
| `uploads/chat_history.json` | Persisted chat history (auto-saved). |
| `uploads/dashboard_config.json` | Pinned chart configurations for the Streamlit dashboard. |

---

## Multi-Step Analysis Pipeline

The chat endpoint (`POST /api/chat`) uses a sophisticated multi-step pipeline:

### Phase 0.5 — Data Extraction (Lean Schema)
1. Build a **Lean Schema** using `data_service.get_schema_string(df, max_tokens=2000)` — only column names, types, and 5 sample rows.
2. Send to `gemini_service.generate_data_extraction_code()` — LLM writes Python code to extract unique values from relevant columns.
3. Execute extraction code via `code_executor.execute_extraction_code()`.
4. The result is a JSON dict of unique values per column (e.g., `{"Country": ["US", "U.S.A.", "United States"]}`).

### Phase 1 — Code Generation (Full Schema)
1. Build a **Full Schema** using `data_service.get_schema_string(df, max_tokens=15000)` — includes metadata, distributions, correlations, and sample rows.
2. Send to `gemini_service.generate_analysis_code()` with the extracted data context from Phase 0.5.
3. Execute the generated Python code against the **full DataFrame** via `code_executor.execute_analysis_code()`.
4. On failure, retry up to 2 times via `gemini_service.retry_analysis_code()`.

### Phase 1.5 — Interpretation
1. Send execution results back to `gemini_service.interpret_results()`.
2. LLM generates a natural language explanation of the computed results.

### Phase 2 — Fallback
If code generation/execution fails entirely, fall back to `gemini_service.analyze_data()` which sends a text summary of the data directly to Gemini for a text-only response.

---

## Token Optimization Strategy

Token usage is a critical concern. The system implements:

| Strategy | Details |
|---|---|
| **Lean Schema** | Phase 0.5 uses `max_tokens=2000` (just metadata + 5 rows). Cost: ~1,500-3,000 tokens. |
| **Full Schema** | Phase 1 uses `max_tokens=15000` with dynamic CSV packing. |
| **History Capping** | Only the last 5 messages are sent to the LLM (`history[-5:]`). |
| **Token Logging** | All LLM calls log `[Label] 🔑 Tokens: X in | Y out | Z total` to the terminal via `_log_token_usage()`. |
| **Programmatic Spotting** | Instead of sending raw data to the LLM, the LLM writes code to programmatically extract unique values, avoiding massive context windows. |

---

## Key Conventions

### Gemini Service (`gemini_service.py`)

- **Model**: Defined in `MODEL_ID` constant (currently `gemini-3.1-flash-lite-preview`).
- **Client**: Uses `google-genai` SDK (`genai.Client`), NOT the deprecated `google-generativeai`.
- **All LLM functions return a tuple**: `(result, usage_metadata)` where `usage_metadata` is a dict with `input_tokens`, `output_tokens`, `total_tokens`.
- **Prompts**: There are 3 main prompts:
  - `SYSTEM_PROMPT` — For text-based analysis (`analyze_data`).
  - `CODE_GEN_PROMPT` — For Python code generation (`generate_analysis_code`).
  - `EXTRACTION_PROMPT` — For data extraction code (`generate_data_extraction_code`).
- **Safety checks in prompts**: The `CODE_GEN_PROMPT` includes explicit instructions to ALWAYS check if DataFrames/collections are empty before accessing elements via `.iloc[0]`.
- **Code response cleaning**: `_call_llm_for_code()` strips markdown fences and returns raw Python code.

### Data Service (`data_service.py`)

- **Column name cleaning**: `clean_column_names(df)` removes newlines/tabs from column names. Called automatically in `get_schema_string()` and `get_data_profile()`.
- **`get_schema_string(df, max_tokens=15000)`**: Generates a structured text context with:
  - Section 1: Overview (rows × columns)
  - Section 2: Column metadata (dtype, unique count, nulls, top values or numeric stats)
  - Section 3: Correlations (only if `max_tokens >= 5000`)
  - Section 4: Sample rows (lean mode: 5 rows; full mode: dynamic CSV packing)
- **`get_data_profile(df)`**: Auto-detects dataset type (`survey`, `time_series`, `financial`, `geographic`, `general`) and column roles (`identifier`, `metric`, `category`, `date`, `text`).
- **`_to_native(val)`**: Converts numpy/pandas types to native Python for JSON serialization.

### Code Executor (`code_executor.py`)

- **Sandboxed environment**: Only `pd` (pandas), `np` (numpy), `json`, and `math` are available.
- **Blocked builtins**: `open`, `eval`, `exec`, `compile`, `__import__`, `globals`, `locals`, `getattr`, `setattr`, `delattr`, `breakpoint`, `exit`, `quit`, `input`, `memoryview`.
- **Expected output**: Code must produce a `result` dict with keys: `text`, `chart` (Plotly JSON or None), `table` (headers/rows or None), `stats` (list of stat cards or None), `followup` (list of follow-up questions).
- **`execute_analysis_code(code_string, df)`**: For Phase 1 analysis code.
- **`execute_extraction_code(code_string, df)`**: For Phase 0.5 extraction code (returns arbitrary dict).
- **`_normalize_table(table)`**: Converts pandas DataFrames to `{"headers": [...], "rows": [[...]]}` format.
- **`_deep_convert(obj)`**: Recursively converts numpy types to native Python.

### Server (`server.py`)

- **Port**: 5000 (Flask with debug mode).
- **CORS**: Enabled for all origins.
- **Static file serving**: Flask serves `dashboard.html`, `script.js`, `styles.css`, etc.
- **Chat history**: Stored in-memory in `chat_histories` dict, persisted to `uploads/chat_history.json`.
- **Query cache**: In-memory `query_cache` dict, keyed by MD5 hash of `(filename, message)`.
- **Token logging**: `_log_token_usage(usage, label)` prints token counts to terminal.
- **Auto-Insights**: Currently **DISABLED** (both frontend call and backend logic).

### Frontend (`script.js` + `dashboard.html`)

- **API base**: `const API_BASE = "http://localhost:5000"`.
- **Libraries used** (loaded via CDN):
  - Plotly.js 2.35.0 — Chart rendering
  - Handsontable — Spreadsheet grid for data preview
  - SheetJS (xlsx) — Client-side Excel parsing
  - Marked.js — Markdown rendering in chat messages
- **View system**: Three views switched via `switchView(viewName)`: `data`, `chat`, `visuals`.
- **Chat flow**: `sendMessage()` → POST `/api/chat` → `appendChatMessage()` with chart/table/stats rendering.
- **Chart actions**: Pin to Dashboard, Download PNG, Expand Fullscreen, Annotate.
- **Smart questions**: Fetched from `/api/suggest-questions` after file upload.
- **Particle background**: Canvas-based animated particle effect in the background.

---

## REST API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload a CSV/Excel file |
| `GET` | `/api/files` | List uploaded files |
| `GET` | `/api/data-summary/<filename>` | Get summary stats for a file |
| `GET` | `/api/suggest-questions` | Get 4 AI-generated question suggestions |
| `POST` | `/api/chat` | Send a message for AI analysis |
| `GET` | `/api/chat/history` | Get chat history |
| `POST` | `/api/chat/clear` | Clear chat history |
| `POST` | `/api/auto-insights` | Auto-insights (currently DISABLED) |
| `GET` | `/api/dashboard` | Get pinned chart configurations |
| `POST` | `/api/dashboard/save` | Save dashboard configuration |
| `POST` | `/api/dashboard/pin` | Pin a single chart |
| `DELETE` | `/api/dashboard/remove/<chart_id>` | Remove a pinned chart |

---

## Design System

- **Font**: `Inter` (Google Fonts), fallback `sans-serif`.
- **Primary Color**: `#4285f4` (Google Blue).
- **Color Palette for Charts**: `["#4285f4", "#ea4335", "#fbbc05", "#34a853", "#ff6d01", "#46bdc6", "#7b1fa2", "#c2185b"]`.
- **Chart Template**: `plotly_white` with `font.family = "Inter, sans-serif"`.
- **Donut Charts**: Use `hole: 0.4`.
- **CSS Variables** (defined in `styles.css`): `--primary-color`, `--text-color`, `--text-light`, `--border-color`, `--font-family`.
- **Glassmorphism**: Sidebar and input bar use `backdrop-filter: blur()` with semi-transparent backgrounds.

---

## Running the Application

### Quick Start (Windows)
```batch
# Double-click start.bat, or run:
cd "c:\Users\DAVID\Desktop\Data Talk"
start.bat
```

### Manual Start
```bash
# Terminal 1: Flask backend
python server.py

# Terminal 2: Streamlit dashboard
streamlit run streamlit_app.py --server.port 8501 --server.headless true

# Open browser to http://localhost:5000
```

### Prerequisites
- Python 3.10+
- `GEMINI_API_KEY` in `.env` file
- Dependencies: `pip install -r requirements.txt`

---

## Common Modification Patterns

### Adding a New Analysis Feature
1. Add/modify the prompt in `gemini_service.py` (e.g., update `CODE_GEN_PROMPT`).
2. If new execution logic is needed, update `code_executor.py`.
3. Wire it into `server.py` endpoint.
4. Update `script.js` to handle new response fields in the frontend.

### Changing the LLM Model
1. Update `MODEL_ID` in `gemini_service.py` (line 21).
2. No other changes needed — all functions reference this constant.

### Adjusting Token Budgets
1. **Phase 0.5 (Extraction)**: Change `max_tokens=2000` in `server.py` `chat()` function.
2. **Phase 1 (Analysis)**: Change `max_tokens=15000` in `server.py` `chat()` function.
3. **Schema default**: Change default param in `data_service.get_schema_string()`.

### Adding a New API Endpoint
1. Add the Flask route in `server.py`.
2. Add the frontend `fetch()` call in `script.js`.
3. Add any UI elements in `dashboard.html`.

---

## Known Limitations & Current State

- **Auto-Insights**: Feature is currently **DISABLED** at both frontend (`script.js`) and backend (`server.py`) levels.
- **Authentication**: `login.html` exists but is not integrated into the main application flow.
- **Chat history**: Capped to last 5 messages when sent to LLM to prevent token bloat.
- **Code execution timeout**: No OS-level timeout on Windows (the `signal.SIGALRM` approach only works on Unix).
- **File types**: Only CSV, XLS, XLSX are supported.
- **Concurrent users**: Not designed for multi-user — uses in-memory state with a single `active_file`.

---

## Debugging Tips

- **Terminal logs**: All LLM interactions print token usage: `[Label] 🔑 Tokens: X in | Y out | Z total`.
- **Pipeline phases**: Watch for `[Extraction]`, `[Code Gen]`, `[Code Exec]`, `[Interpret]`, `[Retry]`, `[Fallback]` log prefixes.
- **Common errors**:
  - `NoneType.__format__`: Usually caused by `NaN` values in numeric stats — handled by `_to_native()` and `_fmt()` in `data_service.py`.
  - `IndexError: index 0 is out of bounds`: LLM code accessing empty DataFrames — mitigated by safety instructions in `CODE_GEN_PROMPT`.
  - High token counts (>100k): Check `max_tokens` parameter in `get_schema_string()` calls.
- **Flask debug mode**: Enabled by default — auto-reloads on file changes.

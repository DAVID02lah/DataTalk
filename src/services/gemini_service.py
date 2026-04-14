"""
gemini_service.py — Google Gemini API integration for Data Talk.

Uses the new `google-genai` SDK (replaces deprecated `google-generativeai`).
Handles sending data context + user questions to Gemini and parsing
structured responses that include natural language + Plotly chart JSON.
"""

import os
import re
import json
import logging
from google import genai
from google.genai import types
from src.core.errors import LLMServiceError

logger = logging.getLogger("data_talk.gemini")

# Create Gemini client (auto-picks up GEMINI_API_KEY env var)
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# Model to use (override via GEMINI_MODEL_ID env var)
# Default to the correct model name; override via GEMINI_MODEL_ID in .env if needed.
MODEL_ID = os.getenv("GEMINI_MODEL_ID", "gemini-3.1-flash-lite-preview")

# Ask Gemini for JSON at the API layer so the parser only has to handle one contract.
JSON_RESPONSE_CONFIG = types.GenerateContentConfig(response_mime_type="application/json")


def _extract_usage_dict(response):
    """Gemini may omit usage metadata, so normalise missing fields to zeroes."""
    meta = getattr(response, "usage_metadata", None)
    return {
        "input_tokens": getattr(meta, "prompt_token_count", 0) or 0,
        "output_tokens": getattr(meta, "candidates_token_count", 0) or 0,
        "total_tokens": getattr(meta, "total_token_count", 0) or 0,
    }


SYSTEM_PROMPT = """You are DATA TALK AI — an expert data analyst assistant.
You help users analyse their datasets by perform data processing and answering questions clearly and generating interactive charts.

Core Guidelines:
1. Always be helpful, concise, professional, and use British English spelling (e.g., 'analyse', 'colour').
2. If the user's message is conversational (e.g. greetings, questions about your identity), respond conversationally WITHOUT data analysis and set chart, table, stats to null.
3. If the question would benefit from a chart/visualisation, generate a Plotly chart specification.
4. If the question involves specific data values, comparisons, or breakdowns, also return a summary table.
5. If a chart is generated, also provide 2-4 key statistical highlights.
6. ALWAYS format your response as valid JSON with this exact structure:
{
  "text": "Your natural language answer here. Use markdown formatting for readability.",
  "chart": null or { plotly chart object },
  "table": null or { "headers": ["Col1", "Col2"], "rows": [["val1", "val2"], ...] },
  "stats": null or [{ "label": "Total", "value": "1,234" }, { "label": "Average", "value": "56.7" }],
  "followup": ["Follow-up question 1", "Follow-up question 2"]
}

TABLE RULES (when table is not null):
- Return table data when the user asks for breakdowns, comparisons, rankings, or detail views.
- "headers" is an array of column header strings.
- "rows" is an array of arrays, each inner array being one row of values.
- If you return a chart, also return the underlying data as a table so users can see exact values.

STATS RULES (when stats is not null):
- Provide 2-4 key statistical insights related to the chart or analysis.
- Each stat is { "label": "...", "value": "..." }
- Good stats: totals, averages, min/max, percentages, counts.
- Format values for readability (e.g., "$1,234.56", "42.3%", "1,500 rows").

CHART RULES (when chart is not null):
- The "chart" value must be a valid Plotly JSON object with "data" and "layout" keys.
- "data" is an array of trace objects (e.g. [{"type": "bar", "x": [...], "y": [...], "name": "..."}])
- "layout" should include: "title", appropriate axis labels, and a clean modern style.
- Use these colors for consistency: ["#4285f4", "#ea4335", "#fbbc05", "#34a853", "#ff6d01", "#46bdc6", "#7b1fa2", "#c2185b"]
- Set layout.template to "plotly_white" for a clean look.
- Set layout.font.family to "Inter, sans-serif".
- Make charts responsive: layout.autosize = true.
- For pie/donut charts, use "hole": 0.4 for donut style.
- IMPORTANT: All data values in the chart must come from the actual dataset provided. Never fabricate data.

If the user's question doesn't need a chart, set "chart" to null.
If no table is relevant, set "table" to null.
If no stats are relevant, set "stats" to null.

FOLLOWUP RULES:
- ALWAYS provide exactly 2-3 follow-up questions the user might ask next.
- Make them contextual to the current analysis and dataset.
- Keep each question short (under 8 words). Add an emoji at the start.
- Example: ["📈 Show the monthly trend", "🔍 Which category has the highest value?", "📊 Compare top 5 items"]

If the data doesn't contain the information needed, explain what's missing.

IMPORTANT: Return ONLY the JSON object. No markdown code fences, no extra text before or after."""


CODE_GEN_PROMPT = """You are DATA TALK AI — an expert data analyst assistant.
You write Python/Pandas code to analyse datasets.
Your job is to write Python code that analyses `df` and produces a `result` dict.

RULES:
1. Write valid Python code using pandas (imported as `pd`) and numpy (imported as `np`).
2. The variable `df` is ALREADY defined as a pandas DataFrame with the FULL dataset.
3. DO NOT try to recreate or hardcode `df`. DO NOT write any data literals. DO NOT include the sample rows in your code.
4. Write ONLY the analysis logic using `df`.
5. Your code MUST create a variable called `result` — a dict with this structure:

result = {
    "text": "Your natural language answer here. Use markdown formatting.",
    "chart": None or { "data": [...plotly traces...], "layout": {...} },
    "table": None or a pandas DataFrame (will be auto-converted),
    "stats": None or [{"label": "Total", "value": "1,234"}, ...],
    "followup": ["Follow-up question 1", "Follow-up question 2"]
}

4. For charts, use Plotly JSON format with "data" and "layout" keys.
   - Use colors: ["#4285f4", "#ea4335", "#fbbc05", "#34a853", "#ff6d01", "#46bdc6", "#7b1fa2", "#c2185b"]
   - Set layout.template to "plotly_white"
   - Set layout.font.family to "Inter, sans-serif"
   - Set layout.autosize = True
   - For pie/donut charts, use "hole": 0.4
5. For tables, you can assign a pandas DataFrame directly — it will be converted automatically.
   Or use {"headers": [...], "rows": [[...], ...]} format.
6. For stats, provide 2-4 key statistics with formatted values (e.g. "$1,234", "42.3%").
7. Always provide 2-3 follow-up questions with an emoji prefix (under 8 words each).
8. Use .tolist() when putting pandas Series or numpy arrays into chart data.
9. Handle potential errors gracefully (e.g. missing columns, type mismatches).
10. SAFETY: ALWAYS check if a DataFrame or result is empty before accessing `.iloc[0]`, `.head(1)`, etc.
11. Do NOT use print() — assign everything to the `result` variable.
12. Do NOT import any modules — `pd`, `np`, and `json` are pre-imported.
13. Your code must be short and efficient. DO NOT hardcode data values.
14. PERFORMANCE (CRITICAL): Use fast, vectorized pandas operations. NEVER use `.iterrows()`, `.apply()`, or manual Python `for` loops to iterate over rows. Always use native pandas/numpy aggregation, filtering, and joining capabilities.

IMPORTANT: Return ONLY the Python code. No markdown code fences, no extra text."""


def analyse_data(question, data_context, chat_history=None):
    """
    Send a question + data context to Gemini and get back a structured response.

    Args:
        question: The user's question string
        data_context: A text summary of the dataset (from data_service.get_context_string)
        chat_history: Optional list of previous messages [{"role": "user"/"model", "text": "..."}]

    Returns:
        dict with keys: "text" (str), "chart" (dict or None)
    """
    # Build the full prompt
    prompt_parts = []

    # System instruction with data context
    prompt_parts.append(SYSTEM_PROMPT)
    prompt_parts.append(f"\n\nHere is the dataset the user uploaded:\n\n{data_context}")

    # Chat history context (if any)
    if chat_history:
        prompt_parts.append("\n\nPrevious conversation:")
        for msg in chat_history[-6:]:  # Last 6 messages for context
            role = "User" if msg["role"] == "user" else "Assistant"
            prompt_parts.append(f"{role}: {msg['text']}")

    # Current question
    prompt_parts.append(f"\n\nUser's current question: {question}")

    full_prompt = "\n".join(prompt_parts)

    try:
        response = client.models.generate_content(
            model=MODEL_ID,
            contents=full_prompt,
            config=JSON_RESPONSE_CONFIG,
        )
        response_text = str(getattr(response, "text", "") or "")
        usage_dict = _extract_usage_dict(response)
        result = _parse_response(response_text)
        result["usage"] = usage_dict
        return result
    except Exception as e:
        raise LLMServiceError(f"Sorry, I encountered an error while analysing your data: {str(e)}")


# Precompiled patterns — evaluated once at import time, not per call.
_GREETING_PATTERNS = re.compile(
    r"^(hi|hello|hey|greetings|good\s*morning|good\s*afternoon|good\s*evening|yo|sup)\b"
)
_FAREWELL_PATTERNS = re.compile(
    r"^(bye|goodbye|see you|take care|thanks|thank you)\b"
)
# Identity / capability probes can appear mid-sentence ("can you tell me what are you?").
_IDENTITY_PATTERNS = re.compile(
    r"(who are you|what are you|what is (your name|datatalk|data talk)"
    r"|what can you do|what do you do|are you (an? )?(ai|bot|assistant)|help me)\b"
)


def is_conversational_query(question: str) -> bool:
    """
    Fast regex intent classifier — prevents wasting LLM tokens on greetings
    or identity questions that don't need dataset context.
    """
    cleaned = question.lower().strip()

    if _IDENTITY_PATTERNS.search(cleaned):
        return True

    # Greetings / farewells are only reliable when the message is short;
    # a long message starting with "hi" is likely a real question.
    if len(cleaned.split()) <= 6:
        if _GREETING_PATTERNS.search(cleaned) or _FAREWELL_PATTERNS.search(cleaned):
            return True

    return False


def conversational_response(question: str, chat_history=None) -> dict:
    """
    Dedicated lightweight LLM path for conversational queries.
    Bypasses data context entirely to save tokens and prevent hallucinated analysis.
    """
    conversational_prompt = (
        "You are DATA TALK AI — a helpful, professional, and friendly data analyst assistant.\n"
        "If the user greets you or asks who you are, introduce yourself and briefly mention "
        "that you can analyse datasets, generate charts, and summarise data.\n"
        "DO NOT invent or reference any specific dataset. Keep your response conversational.\n"
        "Always use British English spelling (e.g., 'analyse', 'colour').\n\n"
        "ALWAYS format your response as valid JSON with this exact structure:\n"
        "{\n"
        '  "text": "Your natural language conversational response.",\n'
        '  "chart": null,\n'
        '  "table": null,\n'
        '  "stats": null,\n'
        '  "followup": ["What kind of data can you analyse?", "How do I upload a dataset?"]\n'
        "}\n"
        "IMPORTANT: Return ONLY the JSON object. No markdown code fences."
    )
    
    prompt_parts = [conversational_prompt]
    
    if chat_history:
        prompt_parts.append("\n\nPrevious conversation:")
        for msg in chat_history[-6:]:
            role = "User" if msg["role"] == "user" else "Assistant"
            prompt_parts.append(f"{role}: {msg['text']}")
            
    prompt_parts.append(f"\n\nUser: {question}")
    full_prompt = "\n".join(prompt_parts)

    try:
        response = client.models.generate_content(
            model=MODEL_ID,
            contents=full_prompt,
            config=JSON_RESPONSE_CONFIG,
        )
        response_text = str(getattr(response, "text", "") or "")
        usage_dict = _extract_usage_dict(response)
        result = _parse_response(response_text)
        result["usage"] = usage_dict
        return result
    except Exception as e:
        logger.error("Conversational LLM Error: %s", e)
        raise LLMServiceError(f"Sorry, I encountered an error while chatting: {e}")


# ==============================================================
# Extraction Prompt (Step 1 of multi-step pipeline)
# ==============================================================

EXTRACTION_PROMPT = """You are DATA TALK AI — a data parsing assistant.
Your job is to write short Python/Pandas code to extract the unique values and their frequencies
for TEXTUAL and CATEGORICAL columns that are relevant to the user's question.

CRITICAL RULES:
1. Identify which categorical/text columns are relevant to the user's question based on the SCHEMA.
2. For each relevant column, calculate the value counts (frequencies).
3. SAFETY CAP: For ANY column, return AT MOST the top 500 most frequent values.
   If there are more than 500 unique values, sum the rest into a key called "Other".
4. Your code MUST assign a Python dictionary to the `result` variable.
   Format: {"ColumnName": {"value1": count1, "value2": count2, "Other": remaining}, ...}
5. The `df` DataFrame is already loaded. `pd` and `np` are pre-imported.
6. Do NOT use print(). Do NOT import anything.

Return ONLY the Python code. No markdown fences."""


def _call_llm_for_code(full_prompt):
    """Internal helper: call Gemini and clean up the response as Python code."""
    try:
        response = client.models.generate_content(
            model=MODEL_ID,
            contents=full_prompt,
        )
        code = str(getattr(response, "text", "") or "").strip()
        usage_dict = _extract_usage_dict(response)

        return code, usage_dict
    except Exception as e:
        logger.error("Code generation error: %s", e)
        raise LLMServiceError(f"Failed to generate code: {e}")


def generate_data_extraction_code(question, schema_context):
    """
    Step 1: Generate code to extract unique values from relevant columns.
    """
    prompt_parts = []
    prompt_parts.append(EXTRACTION_PROMPT)
    prompt_parts.append(f"\n\nDataset Schema:\n{schema_context}")
    prompt_parts.append(f"\n\nUser's question: {question}")
    prompt_parts.append("\nWrite Python code that creates the `result` dictionary:")

    full_prompt = "\n".join(prompt_parts)
    return _call_llm_for_code(full_prompt)


def generate_analysis_code(question, schema_context, chat_history=None, profile_context=None, extracted_data_context=None):
    """
    Step 2: Generate analysis code using schema + extracted unique values.
    """
    prompt_parts = []
    prompt_parts.append(CODE_GEN_PROMPT)
    prompt_parts.append(f"\n\nDataset Schema:\n{schema_context}")

    if extracted_data_context:
        prompt_parts.append(f"\n\nExtracted Unique Values (from relevant columns):\n{extracted_data_context}")

    if profile_context:
        prompt_parts.append(f"\n\nData Profile:\n{profile_context}")

    if chat_history:
        prompt_parts.append("\n\nPrevious conversation:")
        for msg in chat_history[-6:]:
            role = "User" if msg["role"] == "user" else "Assistant"
            prompt_parts.append(f"{role}: {msg['text']}")

    prompt_parts.append(f"\n\nUser's question: {question}")
    prompt_parts.append("\nWrite Python code to answer this question using the `df` DataFrame:")

    full_prompt = "\n".join(prompt_parts)
    return _call_llm_for_code(full_prompt)


def retry_analysis_code(question, schema_context, failed_code, error_message, profile_context=None, extracted_data_context=None):
    """
    Retry code generation after a failure. Sends the error back to Gemini to fix.
    """
    prompt_parts = []
    prompt_parts.append(CODE_GEN_PROMPT)
    prompt_parts.append(f"\n\nDataset Schema:\n{schema_context}")

    if extracted_data_context:
        prompt_parts.append(f"\n\nExtracted Unique Values:\n{extracted_data_context}")

    if profile_context:
        prompt_parts.append(f"\n\nData Profile:\n{profile_context}")

    prompt_parts.append(f"\n\nUser's question: {question}")
    prompt_parts.append(f"\n\nI previously generated this code, but it FAILED:")
    prompt_parts.append(f"```python\n{failed_code}\n```")
    prompt_parts.append(f"\nError: {error_message}")
    prompt_parts.append("\nPlease fix the code. Return ONLY the fixed Python code.")

    full_prompt = "\n".join(prompt_parts)
    return _call_llm_for_code(full_prompt)



def interpret_results(question, schema_context, code_result, chat_history=None):
    """
    Second step of the round trip: send computed results back to Gemini
    for intelligent interpretation and explanation.

    Args:
        question: The user's original question
        schema_context: Schema description of the dataset
        code_result: The result dict from code execution (text, chart, table, stats)
        chat_history: Optional previous messages

    Returns:
        str: Enhanced natural language explanation, or None if it fails
    """
    # Build a compact summary of what the code computed
    result_summary_parts = []

    if code_result.get("text"):
        result_summary_parts.append(f"Code output text: {code_result['text']}")

    if code_result.get("stats"):
        stats_str = ", ".join([f"{s['label']}: {s['value']}" for s in code_result["stats"]])
        result_summary_parts.append(f"Key statistics: {stats_str}")

    if code_result.get("table"):
        table = code_result["table"]
        if isinstance(table, dict) and "headers" in table:
            # Include first few rows to give context
            headers = table["headers"]
            rows = table.get("rows", [])[:10]  # Max 10 rows
            table_str = " | ".join(headers) + "\n"
            for row in rows:
                table_str += " | ".join(str(v) for v in row) + "\n"
            result_summary_parts.append(f"Computed table:\n{table_str}")

    if code_result.get("chart"):
        chart = code_result["chart"]
        chart_type = "unknown"
        if "data" in chart and len(chart["data"]) > 0:
            chart_type = chart["data"][0].get("type", "unknown")
        chart_title = ""
        if "layout" in chart:
            title = chart["layout"].get("title", "")
            if isinstance(title, dict):
                chart_title = title.get("text", "")
            else:
                chart_title = str(title)
        result_summary_parts.append(f"Chart generated: {chart_type} chart titled '{chart_title}'")

    result_summary = "\n".join(result_summary_parts)

    prompt = f"""You are DATA TALK AI — an expert data analyst.

The user asked: "{question}"

Dataset schema:
{schema_context}

Python code was executed on the FULL dataset and produced these results:
{result_summary}

Based on these ACTUAL computed results, provide a clear, insightful explanation.
- Explain what the numbers mean in plain language
- Highlight any notable patterns, outliers, or trends
- If relevant, suggest possible reasons or factors behind the findings
- Use markdown formatting for readability
- Keep it concise (2-4 paragraphs max)

Return ONLY the explanation text, no JSON, no code fences."""

    # Add chat history for context
    if chat_history:
        history_str = "\n".join([
            f"{'User' if m['role'] == 'user' else 'AI'}: {m['text']}"
            for m in chat_history[-4:]
        ])
        prompt += f"\n\nRecent conversation:\n{history_str}"

    try:
        response = client.models.generate_content(
            model=MODEL_ID,
            contents=prompt,
        )
        return str(getattr(response, "text", "") or "").strip(), _extract_usage_dict(response)
    except Exception as e:
        logger.error("Interpretation error: %s", e)
        raise LLMServiceError(f"Failed to interpret results: {e}")


def _parse_response(response_text):
    """
    Parse Gemini's JSON response into structured text + chart JSON.
    The API now asks Gemini for JSON directly, so this parser only normalises
    the expected object and keeps a plain-text fallback for rare contract breaks.
    """
    try:
        parsed = json.loads(str(response_text or "").strip())
    except json.JSONDecodeError:
        return _fallback_structured_response(str(response_text or "").strip())

    if not isinstance(parsed, dict):
        return _fallback_structured_response(str(response_text or "").strip())

    return _normalise_structured_response(parsed)


def _normalise_structured_response(payload):
    """Keep the API response shape stable even if Gemini omits optional fields."""
    chart = payload.get("chart")
    table = payload.get("table")
    stats = payload.get("stats")
    followup = payload.get("followup")

    return {
        "text": str(payload.get("text", "") or ""),
        "chart": chart if isinstance(chart, dict) else None,
        "table": table if isinstance(table, dict) else None,
        "stats": stats if isinstance(stats, list) else None,
        "followup": followup if isinstance(followup, list) else [],
    }


def _fallback_structured_response(text):
    """Preserve the user-visible answer when the model misses the JSON contract."""
    return {
        "text": text,
        "chart": None,
        "table": None,
        "stats": None,
        "followup": [],
    }

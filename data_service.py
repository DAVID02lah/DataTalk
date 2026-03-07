"""
data_service.py — Data loading and summarization utilities for Data Talk.
"""

import os
import re
import warnings
import pandas as pd
from werkzeug.utils import secure_filename


UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls"}


def ensure_upload_dir():
    """Create the uploads directory if it doesn't exist."""
    os.makedirs(UPLOAD_DIR, exist_ok=True)


def save_uploaded_file(file_storage):
    """
    Save a Flask FileStorage object to the uploads directory.
    Returns the filename and full path.
    """
    ensure_upload_dir()
    raw_filename = file_storage.filename or ""
    filename = secure_filename(raw_filename)
    if not filename:
        raise ValueError("Invalid file name.")

    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(f"Unsupported file type: {ext}")

    filepath = _resolve_upload_path(filename)

    # Avoid accidental overwrite by appending a numeric suffix.
    base_name, base_ext = os.path.splitext(filename)
    index = 1
    while os.path.exists(filepath):
        filename = f"{base_name}_{index}{base_ext}"
        filepath = _resolve_upload_path(filename)
        index += 1

    file_storage.save(filepath)
    return filename, filepath


def load_file(filename):
    """
    Load a CSV or Excel file from the uploads directory into a pandas DataFrame.
    """
    filepath = _resolve_upload_path(filename)
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"File not found: {filename}")

    ext = os.path.splitext(filepath)[1].lower()
    if ext == ".csv":
        df = pd.read_csv(filepath)
    elif ext in (".xlsx", ".xls"):
        df = pd.read_excel(filepath, engine="openpyxl")
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    return df


def get_summary(df):
    """
    Return a summary dict of the DataFrame: columns, dtypes, shape, and basic stats.
    """
    summary = {
        "columns": list(df.columns),
        "dtypes": {col: str(dtype) for col, dtype in df.dtypes.items()},
        "shape": {"rows": df.shape[0], "columns": df.shape[1]},
        "preview": df.head(5).fillna("").to_dict(orient="records"),
        "describe": {}
    }

    # Add describe() for numeric columns
    try:
        desc = df.describe(include="all").fillna("").to_dict()
        # Convert numpy types to native Python types for JSON serialization
        clean_desc = {}
        for col, stats in desc.items():
            clean_desc[col] = {k: _to_native(v) for k, v in stats.items()}
        summary["describe"] = clean_desc
    except Exception:
        pass

    return summary


def get_context_string(df, max_rows=15):
    """
    Create a text representation of the DataFrame suitable for sending to Gemini
    as context. Includes column info and sample data.
    """
    lines = []
    lines.append(f"Dataset: {df.shape[0]} rows × {df.shape[1]} columns\n")

    # Column info
    lines.append("Columns:")
    for col in df.columns:
        dtype = str(df[col].dtype)
        nunique = df[col].nunique()
        nulls = df[col].isnull().sum()
        lines.append(f"  - {col} (type: {dtype}, unique: {nunique}, nulls: {nulls})")

    lines.append("")

    # Sample data as CSV
    sample = df.head(max_rows)
    lines.append(f"First {min(max_rows, len(df))} rows (CSV format):")
    lines.append(sample.to_csv(index=False))

    return "\n".join(lines)


def clean_column_names(df):
    """
    Clean column names by replacing newlines, carriage returns, tabs,
    and excessive whitespace with single spaces. Returns a new DataFrame.
    """
    df = df.copy()
    df.columns = [re.sub(r'\s+', ' ', str(col)).strip() for col in df.columns]
    return df


def get_schema_string(df, max_tokens=15000):
    """
    Create a rich context description of the DataFrame for LLM code generation.
    Includes column metadata, value distributions, correlations, and sample rows.
    Dynamically fits content within the token budget (~4 chars per token).
    """
    df = clean_column_names(df)
    char_budget = max_tokens * 4  # ~4 chars per token
    lines = []

    # === Section 1: Overview ===
    lines.append(f"Dataset: {df.shape[0]} rows × {df.shape[1]} columns\n")

    # === Section 2: Column metadata + distributions ===
    lines.append("Columns:")
    for col in df.columns:
        dtype = str(df[col].dtype)
        nunique = df[col].nunique()
        nulls = df[col].isnull().sum()
        line = f"  - '{col}' (dtype: {dtype}, unique: {nunique}, nulls: {nulls})"

        if pd.api.types.is_numeric_dtype(df[col]):
            desc = df[col].describe()
            
            def _fmt(val, float_fmt=False):
                v = _to_native(val)
                if v is None or v == "N/A": 
                    return "N/A"
                if not isinstance(v, (int, float)):
                    return str(v)
                return f"{v:.2f}" if float_fmt else str(v)

            line += (f" | min={_fmt(desc.get('min', 'N/A'))}, "
                     f"mean={_fmt(desc.get('mean', 'N/A'), True)}, "
                     f"median={_fmt(desc.get('50%', 'N/A'))}, "
                     f"max={_fmt(desc.get('max', 'N/A'))}, "
                     f"std={_fmt(desc.get('std', 'N/A'), True)}")
        elif pd.api.types.is_object_dtype(df[col]) or isinstance(df[col].dtype, pd.CategoricalDtype):
            top_vals = df[col].value_counts().head(10)
            if len(top_vals) > 0:
                vals_str = ", ".join([f"'{k}' ({v})" for k, v in top_vals.items()])
                line += f" | top values: {vals_str}"
        
        lines.append(line)

    # === Section 3: Correlations (only for larger budgets) ===
    if max_tokens >= 5000:
        numeric_cols = df.select_dtypes(include="number").columns.tolist()
        if len(numeric_cols) >= 2:
            lines.append("\nTop correlations:")
            try:
                corr_matrix = df[numeric_cols].corr()
                pairs = []
                for i, c1 in enumerate(numeric_cols):
                    for c2 in numeric_cols[i+1:]:
                        val = corr_matrix.loc[c1, c2]
                        if pd.notna(val):
                            pairs.append((c1, c2, val))
                pairs.sort(key=lambda x: abs(x[2]), reverse=True)
                for c1, c2, val in pairs[:10]:
                    strength = "strong" if abs(val) > 0.7 else "moderate" if abs(val) > 0.4 else "weak"
                    direction = "positive" if val > 0 else "negative"
                    lines.append(f"  - '{c1}' ↔ '{c2}': {val:.3f} ({strength} {direction})")
            except Exception:
                pass

    # === Section 4: Sample rows ===
    lines.append("")
    metadata_text = "\n".join(lines)
    remaining_chars = char_budget - len(metadata_text) - 200

    if max_tokens < 5000:
        # Lean mode: skip aggressive packing, just 5 rows
        lines.append(f"Sample data (First 5 rows, CSV format):")
        lines.append(df.head(5).to_csv(index=False))
    elif remaining_chars > 500:
        sample_csv = df.to_csv(index=False)
        csv_lines = sample_csv.split("\n")
        header = csv_lines[0]
        fitted_lines = [header]
        chars_used = len(header)
        row_count = 0
        for csv_line in csv_lines[1:]:
            if chars_used + len(csv_line) + 1 > remaining_chars:
                break
            fitted_lines.append(csv_line)
            chars_used += len(csv_line) + 1
            row_count += 1
        lines.append(f"Sample data ({row_count} of {df.shape[0]} rows):")
        lines.append("\n".join(fitted_lines))
    else:
        lines.append(df.head(5).to_csv(index=False))

    return "\n".join(lines)


def get_data_profile(df):
    """
    Auto-detect dataset characteristics and suggest appropriate analyses.
    Returns a dict with dataset_type, column_roles, and suggested_analyses.
    This is included in the LLM prompt so it writes domain-aware analysis code.
    """
    df = clean_column_names(df)
    profile = {
        "dataset_type": "general",
        "column_roles": {},
        "suggested_analyses": [],
        "summary_stats": {}
    }

    n_rows, n_cols = df.shape
    numeric_cols = df.select_dtypes(include="number").columns.tolist()
    cat_cols = df.select_dtypes(include=["object", "category"]).columns.tolist()
    datetime_cols = df.select_dtypes(include="datetime").columns.tolist()

    # Try to detect datetime columns that are stored as strings
    for col in cat_cols[:]:
        if df[col].dropna().empty:
            continue
        sample = df[col].dropna().head(20)
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
            if parsed.notna().sum() > len(sample) * 0.8:
                datetime_cols.append(col)
                cat_cols.remove(col)
        except (ValueError, TypeError):
            pass

    # === Classify column roles ===
    for col in df.columns:
        role = "unknown"
        nunique = df[col].nunique()
        null_pct = df[col].isnull().mean()

        if col in datetime_cols or col.lower() in ("timestamp", "date", "datetime", "time", "created_at", "updated_at"):
            role = "timestamp"
        elif col in numeric_cols:
            if nunique <= 2:
                role = "binary"
            elif nunique <= 10 and nunique / max(n_rows, 1) < 0.05:
                role = "ordinal"
            elif nunique == n_rows or col.lower() in ("id", "index", "row", "no", "no."):
                role = "id"
            else:
                role = "measure"
        elif col in cat_cols:
            avg_len = df[col].dropna().astype(str).str.len().mean() if not df[col].dropna().empty else 0
            if nunique == n_rows or nunique / max(n_rows, 1) > 0.9:
                if avg_len > 50:
                    role = "free_text"
                else:
                    role = "id"
            elif avg_len > 100:
                role = "free_text"
            elif nunique <= 2:
                role = "binary"
            else:
                role = "category"

        profile["column_roles"][col] = role

    # === Detect dataset type ===
    role_counts = {}
    for r in profile["column_roles"].values():
        role_counts[r] = role_counts.get(r, 0) + 1

    has_timestamps = role_counts.get("timestamp", 0) > 0
    has_categories = role_counts.get("category", 0) > 0
    has_measures = role_counts.get("measure", 0) > 0
    has_ordinals = role_counts.get("ordinal", 0) > 0
    has_binary = role_counts.get("binary", 0) > 0
    has_free_text = role_counts.get("free_text", 0) > 0
    n_categories = role_counts.get("category", 0)

    # Survey data: many ordinal/categorical columns, possibly Likert-scale questions
    if (has_ordinals or has_binary) and n_categories >= 3:
        profile["dataset_type"] = "survey"
    # Time series: has timestamps + numeric measures
    elif has_timestamps and has_measures:
        profile["dataset_type"] = "time_series"
    # Transactional: has timestamps + categories + amounts
    elif has_timestamps and has_categories:
        profile["dataset_type"] = "transactional"
    # Mostly categorical
    elif n_categories >= n_cols * 0.6:
        profile["dataset_type"] = "categorical"
    # Mostly numeric
    elif len(numeric_cols) >= n_cols * 0.6:
        profile["dataset_type"] = "numerical"

    # === Generate analysis suggestions based on dataset type ===
    suggestions = []

    if profile["dataset_type"] == "survey":
        suggestions.extend([
            "Cross-tabulate key categorical variables to find patterns across demographics",
            "Compute response distributions for each question (value_counts with percentages)",
            "Compare responses across demographic groups (age, gender, location) using groupby",
            "If ordinal/Likert scales exist, compute mean scores by group and visualize with heatmaps",
            "Identify correlations between different survey responses",
            "Look for demographic segments with notably different response patterns"
        ])
    elif profile["dataset_type"] == "time_series":
        suggestions.extend([
            "Show trends over time with line charts",
            "Compute rolling averages to smooth out noise",
            "Identify seasonal patterns or cyclical behavior",
            "Calculate period-over-period changes (growth rates)",
            "Find peak and trough periods"
        ])
    elif profile["dataset_type"] == "transactional":
        suggestions.extend([
            "Aggregate by category and show top-N breakdowns",
            "Show trends over time by category",
            "Compute totals, averages, and distributions",
            "Identify top performers or outliers",
            "Compare categories using grouped bar charts"
        ])
    elif profile["dataset_type"] == "categorical":
        suggestions.extend([
            "Show frequency distributions for each category",
            "Cross-tabulate two or more categorical variables",
            "Use stacked or grouped bar charts for comparisons",
            "Compute contingency tables and proportions"
        ])
    elif profile["dataset_type"] == "numerical":
        suggestions.extend([
            "Compute descriptive statistics (mean, median, std, quartiles)",
            "Show distributions using histograms or box plots",
            "Compute correlation matrix between numeric variables",
            "Identify outliers using IQR or z-score methods",
            "Create scatter plots for pairs of correlated variables"
        ])

    # Universal suggestions
    suggestions.extend([
        "Always provide specific numbers and percentages in explanations",
        "Highlight the most interesting finding, not just describe the chart",
        "If the user asks a vague question, pick the most insightful angle from the data"
    ])

    profile["suggested_analyses"] = suggestions

    # === Summary stats ===
    profile["summary_stats"] = {
        "total_rows": n_rows,
        "total_columns": n_cols,
        "numeric_columns": len(numeric_cols),
        "categorical_columns": len(cat_cols),
        "datetime_columns": len(datetime_cols),
        "missing_pct": round(df.isnull().mean().mean() * 100, 1)
    }

    return profile


def get_profile_string(profile):
    """Convert a data profile dict into a text string for LLM prompts."""
    lines = []
    lines.append(f"Dataset type: {profile['dataset_type']}")
    lines.append(f"Stats: {profile['summary_stats']['total_rows']} rows, "
                 f"{profile['summary_stats']['total_columns']} columns, "
                 f"{profile['summary_stats']['missing_pct']}% missing values")
    lines.append("")

    lines.append("Column roles:")
    for col, role in profile["column_roles"].items():
        lines.append(f"  - '{col}': {role}")
    lines.append("")

    lines.append("Recommended analysis approaches for this dataset:")
    for i, suggestion in enumerate(profile["suggested_analyses"], 1):
        lines.append(f"  {i}. {suggestion}")

    return "\n".join(lines)


def list_uploaded_files():
    """Return a list of filenames in the uploads directory."""
    ensure_upload_dir()
    files = []
    for f in os.listdir(UPLOAD_DIR):
        ext = os.path.splitext(f)[1].lower()
        if ext in ALLOWED_EXTENSIONS:
            filepath = _resolve_upload_path(f)
            files.append({
                "filename": f,
                "size_bytes": os.path.getsize(filepath)
            })
    return files


def _resolve_upload_path(filename):
    """Resolve a filename under uploads and block path traversal."""
    if not filename:
        raise ValueError("Filename is required.")

    raw_name = str(filename)
    clean_name = os.path.basename(raw_name)
    if clean_name != raw_name:
        raise ValueError("Invalid file path.")

    upload_root = os.path.realpath(UPLOAD_DIR)
    candidate = os.path.realpath(os.path.join(upload_root, clean_name))

    if os.path.commonpath([upload_root, candidate]) != upload_root:
        raise ValueError("Invalid file path.")

    return candidate


def _to_native(val):
    """Convert numpy/pandas types to native Python types for JSON serialization."""
    try:
        if pd.isna(val):
            return None
    except (TypeError, ValueError):
        pass
    if hasattr(val, "item"):
        return val.item()
    return val

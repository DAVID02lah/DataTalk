"""Sandboxed execution of LLM-generated Python/Pandas code for Data Talk.

Executes generated analysis code against the full DataFrame in a restricted
environment. Dangerous operations are blocked with static validation and a
subprocess timeout guard.
"""

import ast
import json
import multiprocessing
import queue
import re
import traceback

import numpy as np
import pandas as pd


EXEC_TIMEOUT = 60
MAX_CODE_LENGTH = 10000

BLOCKED_BUILTINS = {
    "open",
    "eval",
    "exec",
    "compile",
    "__import__",
    "globals",
    "locals",
    "getattr",
    "setattr",
    "delattr",
    "breakpoint",
    "exit",
    "quit",
    "input",
    "memoryview",
    "classmethod",
    "staticmethod",
    "property",
    "super",
}

FORBIDDEN_NAMES = {
    "os",
    "sys",
    "subprocess",
    "socket",
    "pathlib",
    "shutil",
    "builtins",
    "importlib",
    "ctypes",
}

FORBIDDEN_ATTRS = {
    "__class__",
    "__bases__",
    "__dict__",
    "__mro__",
    "__subclasses__",
    "__globals__",
    "__getattribute__",
    "__code__",
    "__closure__",
    "__func__",
    "system",
    "popen",
    "remove",
    "unlink",
}


def _blocked(*_args, **_kwargs):
    raise PermissionError("This operation is not allowed in the sandbox.")


class _SafetyVisitor(ast.NodeVisitor):
    """Reject unsafe syntax before execution."""

    def visit_Import(self, node):
        raise PermissionError(f"Import statements are not allowed (line {node.lineno}).")

    def visit_ImportFrom(self, node):
        raise PermissionError(f"Import statements are not allowed (line {node.lineno}).")

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load) and node.id in FORBIDDEN_NAMES:
            raise PermissionError(f"Usage of '{node.id}' is not allowed (line {node.lineno}).")
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if node.attr.startswith("__") or node.attr in FORBIDDEN_ATTRS:
            raise PermissionError(f"Access to '{node.attr}' is not allowed (line {node.lineno}).")
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_BUILTINS:
            raise PermissionError(f"Call to '{node.func.id}' is not allowed (line {node.lineno}).")
        if isinstance(node.func, ast.Attribute) and node.func.attr in FORBIDDEN_ATTRS:
            raise PermissionError(f"Call to '{node.func.attr}' is not allowed (line {node.lineno}).")
        self.generic_visit(node)


def _make_safe_builtins():
    """Create a restricted builtins dict that blocks dangerous functions."""
    import builtins

    safe = {}
    for name in dir(builtins):
        if name.startswith("_") and name != "__name__":
            continue
        if name.lower() in BLOCKED_BUILTINS:
            continue
        safe[name] = getattr(builtins, name)
    safe["__import__"] = _blocked
    return safe


def _clean_code(code_string):
    """Normalize model output and remove markdown code fences."""
    code_string = (code_string or "").strip()
    if code_string.startswith("```"):
        lines = code_string.split("\n")
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        code_string = "\n".join(lines)
    return code_string.strip()


def _validate_generated_code(code_string):
    """Parse and validate generated Python code against safety rules."""
    tree = ast.parse(code_string, mode="exec")
    _SafetyVisitor().visit(tree)


def _execute_in_subprocess(code_string, df, result_queue):
    """Execute validated code in an isolated subprocess and return result payload."""
    safe_builtins = _make_safe_builtins()
    exec_globals = {
        "__builtins__": safe_builtins,
        "pd": pd,
        "pandas": pd,
        "np": np,
        "numpy": np,
        "json": json,
        "df": df.copy(),
        "result": None,
    }

    exec_globals["df"].columns = [
        re.sub(r"\s+", " ", str(col)).strip() for col in exec_globals["df"].columns
    ]

    try:
        compiled = compile(code_string, "<llm_code>", "exec")
        exec(compiled, exec_globals)
        result_queue.put({"ok": True, "result": exec_globals.get("result")})
    except Exception as exc:
        tb = traceback.format_exc()
        result_queue.put({"ok": False, "error": str(exc), "traceback": tb})


def _run_with_timeout(code_string, df, timeout_seconds):
    """Run analysis code in a subprocess and force-stop on timeout."""
    ctx = multiprocessing.get_context("spawn")
    result_queue = ctx.Queue(maxsize=1)
    proc = ctx.Process(target=_execute_in_subprocess, args=(code_string, df, result_queue))
    proc.start()
    proc.join(timeout_seconds)

    if proc.is_alive():
        proc.terminate()
        proc.join(2)
        raise TimeoutError(
            f"Code execution timed out (exceeded {timeout_seconds} seconds). Try a simpler analysis."
        )

    try:
        payload = result_queue.get_nowait()
    except queue.Empty:
        raise RuntimeError("Code process ended without returning a result.")

    if not payload.get("ok"):
        err = payload.get("error", "Unknown execution error")
        tb = payload.get("traceback", "")
        tb_lines = tb.strip().split("\n") if tb else []
        short_tb = "\n".join(tb_lines[-3:])
        raise RuntimeError(f"Code execution error: {err}\n{short_tb}")

    return payload.get("result")


def execute_analysis_code(code_string, df):
    """Execute LLM-generated Python code in a restricted sandbox."""
    code_string = _clean_code(code_string)

    if len(code_string) > MAX_CODE_LENGTH:
        return _error_result(
            "The generated code is too large (over 10,000 characters). "
            "This usually means the AI tried to hardcode the dataset instead of analyzing it. "
            "Falling back to text-based analysis."
        )

    try:
        _validate_generated_code(code_string)
        result = _run_with_timeout(code_string, df, EXEC_TIMEOUT)

        if result is None:
            return _error_result(
                "The generated code did not produce a 'result' variable. "
                "Falling back to text-based analysis."
            )
        if not isinstance(result, dict):
            return _error_result(
                "The generated code produced a 'result' that is not a dict. "
                "Falling back to text-based analysis."
            )

        normalized = {
            "text": str(result.get("text", "Analysis complete.")),
            "chart": _deep_convert(result.get("chart", None)),
            "table": _normalize_table(result.get("table", None)),
            "stats": _deep_convert(result.get("stats", None)),
            "followup": _deep_convert(result.get("followup", [])),
        }
        return normalized

    except SyntaxError as exc:
        return _error_result(f"Syntax error in generated code: {exc}")
    except PermissionError as exc:
        return _error_result(f"Security violation: {exc}")
    except TimeoutError as exc:
        return _error_result(str(exc))
    except Exception as exc:
        return _error_result(str(exc))


def execute_extraction_code(code_string, df):
    """Execute extraction code expected to place a dictionary in `result`."""
    code_string = _clean_code(code_string)
    if len(code_string) > MAX_CODE_LENGTH:
        return {"error": True, "text": "Extraction code is too large."}

    try:
        _validate_generated_code(code_string)
        result = _run_with_timeout(code_string, df, EXEC_TIMEOUT)
        if result is None or not isinstance(result, dict):
            return {"error": True, "text": "Extraction code did not produce a result dict."}
        return _deep_convert(result)
    except TimeoutError:
        return {"error": True, "text": "Extraction code timed out."}
    except PermissionError as exc:
        return {"error": True, "text": f"Security violation: {exc}"}
    except Exception as exc:
        return {"error": True, "text": f"Extraction error: {exc}"}


def _error_result(message):
    return {
        "error": True,
        "text": message,
        "chart": None,
        "table": None,
        "stats": None,
        "followup": [],
    }


def _normalize_table(table):
    if table is None:
        return None

    if isinstance(table, pd.DataFrame):
        return {
            "headers": _deep_convert(list(table.columns)),
            "rows": _deep_convert(table.fillna("").values.tolist()),
        }

    if isinstance(table, dict) and "headers" in table and "rows" in table:
        return _deep_convert(table)

    return None


def _deep_convert(obj):
    if isinstance(obj, dict):
        return {k: _deep_convert(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_deep_convert(item) for item in obj]
    if isinstance(obj, pd.Series):
        return _deep_convert(obj.tolist())
    if isinstance(obj, pd.Index):
        return _deep_convert(obj.tolist())
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, pd.Timestamp):
        return str(obj)
    if hasattr(obj, "item"):
        try:
            return obj.item()
        except (ValueError, TypeError):
            return str(obj)
    try:
        if pd.isna(obj):
            return None
    except (TypeError, ValueError):
        pass
    return obj

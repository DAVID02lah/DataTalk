"""Sandboxed execution of LLM-generated Python/Pandas code for Data Talk.

Executes generated analysis code against the full DataFrame in a restricted
environment. Dangerous operations are blocked with static validation and a
subprocess timeout guard.
"""

import ast
import json
import re
import multiprocessing
import traceback

import numpy as np
import pandas as pd

from src.core import app_config
from src.core.errors import CodeExecutionError
from src.core.value_utils import to_native

EXEC_TIMEOUT = app_config.EXEC_TIMEOUT
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
    "__builtins__",
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


def _worker_target(code_string, df, queue):
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
        queue.put({"ok": True, "result": exec_globals.get("result")})
    except Exception as exc:
        tb = traceback.format_exc()
        queue.put({"ok": False, "error": str(exc), "traceback": tb})


def _run_with_timeout(code_string, df, timeout_seconds):
    """Run analysis code in a subprocess and force-terminate on timeout.

    multiprocessing ensures the OS reclaims the child process on termination,
    preventing CPU/memory leaks from infinite loops or blocking operations.

    SECURITY NOTE: This is a best-effort sandbox, not a full isolation boundary.
    The Python environment is not hardened against determined adversaries.
    Do not expose this endpoint to untrusted public users without additional
    controls (e.g. seccomp, container isolation, network restrictions).
    """
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()

    process = ctx.Process(target=_worker_target, args=(code_string, df, queue), daemon=True)
    process.start()
    process.join(timeout_seconds)

    if process.is_alive():
        process.terminate()
        process.join()  # Ensure OS-level cleanup before propagating the error.
        raise TimeoutError(
            f"Code execution timed out (exceeded {timeout_seconds} seconds). Try a simpler analysis."
        )

    if not queue.empty():
        return queue.get().get("result")

    raise RuntimeError("Code execution ended without returning a result.")


def execute_analysis_code(code_string, df):
    """Execute LLM-generated Python code in a restricted sandbox."""
    code_string = _clean_code(code_string)

    if len(code_string) > MAX_CODE_LENGTH:
        raise CodeExecutionError(
            "The generated code is too large (over 10,000 characters). "
            "This usually means the AI tried to hardcode the dataset instead of analysing it. "
            "Falling back to text-based analysis."
        )

    try:
        _validate_generated_code(code_string)
        result = _run_with_timeout(code_string, df, EXEC_TIMEOUT)

        if result is None:
            raise CodeExecutionError(
                "The generated code did not produce a 'result' variable. "
                "Falling back to text-based analysis."
            )
        if not isinstance(result, dict):
            raise CodeExecutionError(
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
        raise CodeExecutionError(f"Syntax error in generated code: {exc}")
    except PermissionError as exc:
        raise CodeExecutionError(f"Security violation: {exc}")
    except TimeoutError as exc:
        raise CodeExecutionError(str(exc))
    except Exception as exc:
        raise CodeExecutionError(str(exc))


def execute_extraction_code(code_string, df):
    """Execute extraction code expected to place a dictionary in `result`."""
    code_string = _clean_code(code_string)
    if len(code_string) > MAX_CODE_LENGTH:
        raise CodeExecutionError("Extraction code is too large.")

    try:
        _validate_generated_code(code_string)
        result = _run_with_timeout(code_string, df, EXEC_TIMEOUT)
        if result is None or not isinstance(result, dict):
            raise CodeExecutionError("Extraction code did not produce a result dict.")
        return _deep_convert(result)
    except TimeoutError:
        raise CodeExecutionError("Extraction code timed out.")
    except PermissionError as exc:
        raise CodeExecutionError(f"Security violation: {exc}")
    except Exception as exc:
        raise CodeExecutionError(f"Extraction error: {exc}")


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
    return to_native(obj)

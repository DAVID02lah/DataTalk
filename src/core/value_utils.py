"""Shared value normalization helpers."""

from __future__ import annotations

import pandas as pd


def to_native(val):
    """Convert pandas/numpy scalars to plain Python values for serialization."""
    try:
        if pd.isna(val):
            return None
    except (TypeError, ValueError):
        pass

    if hasattr(val, "item"):
        try:
            return val.item()
        except (ValueError, TypeError):
            return val

    return val

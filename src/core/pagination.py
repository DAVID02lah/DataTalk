"""Pagination helpers for API responses."""

from __future__ import annotations

from typing import Any


def paginate(items: list[Any], page: int = 1, per_page: int = 50, max_page_size: int = 100) -> dict[str, Any]:
    """Clamp pagination inputs and return one consistent page payload."""
    total = len(items)
    per_page = max(1, min(int(per_page or 1), int(max_page_size or 1)))
    total_pages = max(1, -(-total // per_page))
    page = max(1, min(int(page or 1), total_pages))
    start = (page - 1) * per_page
    return {
        "items": items[start:start + per_page],
        "page": page,
        "per_page": per_page,
        "total": total,
        "total_pages": total_pages,
    }
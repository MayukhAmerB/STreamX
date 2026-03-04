def apply_optional_pagination(request, queryset, *, default_page_size=20, max_page_size=100):
    """
    Optional pagination:
    - disabled by default (preserves existing API response shape)
    - enable with ?paginate=1
    """
    paginate = str(request.query_params.get("paginate", "")).lower() in {"1", "true", "yes"}
    if not paginate:
        return queryset, None

    try:
        page = max(int(request.query_params.get("page", "1")), 1)
    except (TypeError, ValueError):
        page = 1

    try:
        page_size = int(request.query_params.get("page_size", str(default_page_size)))
    except (TypeError, ValueError):
        page_size = default_page_size
    page_size = max(1, min(page_size, max_page_size))

    total = queryset.count()
    offset = (page - 1) * page_size
    items = queryset[offset : offset + page_size]

    meta = {
        "page": page,
        "page_size": page_size,
        "total": total,
        "pages": (total + page_size - 1) // page_size if total else 0,
        "has_next": offset + page_size < total,
        "has_previous": page > 1,
    }
    return items, meta

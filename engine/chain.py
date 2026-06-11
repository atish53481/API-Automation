import re
from typing import Any, Dict, Optional


def extract_value(data: Any, path: str) -> Optional[Any]:
    """Extract value from nested dict using dot notation or JSONPath ($.)"""
    if data is None or not path:
        return None
    path = path.strip().lstrip("$").lstrip(".")
    if not path:
        return data

    result = data
    for part in path.split("."):
        if result is None:
            return None
        m = re.match(r"^(\w+)\[(\d+)\]$", part)
        if m:
            key, idx = m.group(1), int(m.group(2))
            result = result.get(key) if isinstance(result, dict) else None
            result = result[idx] if isinstance(result, list) and idx < len(result) else None
        elif isinstance(result, dict):
            result = result.get(part)
        elif isinstance(result, list):
            try:
                result = result[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return result


def inject_context(data: Any, context: Dict[str, Any]) -> Any:
    """Replace {{var}} placeholders with context values (recursive)"""
    if isinstance(data, str):
        def _sub(m: re.Match) -> str:
            val = context.get(m.group(1).strip())
            return str(val) if val is not None else m.group(0)
        return re.sub(r"\{\{([^}]+)\}\}", _sub, data)
    if isinstance(data, dict):
        return {k: inject_context(v, context) for k, v in data.items()}
    if isinstance(data, list):
        return [inject_context(item, context) for item in data]
    return data


def resolve_path(path: str, context: Dict[str, Any]) -> str:
    """Resolve path params like /users/{id} from context"""
    def _sub(m: re.Match) -> str:
        val = context.get(m.group(1))
        return str(val) if val is not None else m.group(0)
    return re.sub(r"\{([^}]+)\}", _sub, path)

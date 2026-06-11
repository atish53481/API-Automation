import json
import re
from urllib.parse import urlparse
import yaml
from typing import Any, Dict, List, Optional
from models.schemas import ParsedEndpoint, ParseSpecResponse


# ── Postman Collection v2.0 / v2.1 ───────────────────────────────────────────

def _json_to_schema(data) -> Dict:
    """Build minimal JSON schema from a sample value."""
    if isinstance(data, dict):
        return {"type": "object", "properties": {k: _json_to_schema(v) for k, v in data.items()}}
    if isinstance(data, list):
        return {"type": "array", "items": _json_to_schema(data[0]) if data else {}}
    if isinstance(data, bool):
        return {"type": "boolean"}
    if isinstance(data, int):
        return {"type": "integer"}
    if isinstance(data, float):
        return {"type": "number"}
    return {"type": "string"}


def _flatten_postman_items(items: List) -> List[Dict]:
    """Recursively flatten folders into flat request list."""
    result = []
    for item in items:
        if "item" in item:          # folder
            result.extend(_flatten_postman_items(item["item"]))
        elif "request" in item:
            result.append(item)
    return result


def _parse_postman_url(url_obj) -> tuple:
    """Return (base_url, path) from a Postman URL object or raw string."""
    if isinstance(url_obj, str):
        p = urlparse(url_obj)
        base = f"{p.scheme}://{p.netloc}" if p.netloc else ""
        return base, p.path or "/"

    raw = url_obj.get("raw", "")
    protocol = url_obj.get("protocol", "https")
    host_parts = url_obj.get("host", [])
    path_parts = url_obj.get("path", [])

    host = ".".join(host_parts) if isinstance(host_parts, list) else str(host_parts)
    base = f"{protocol}://{host}" if host else ""

    # Convert path segments; replace numeric-only segments with {id}
    def seg(p):
        s = str(p)
        return "{id}" if re.fullmatch(r"\d+", s) else s

    path = "/" + "/".join(seg(p) for p in path_parts) if path_parts else (urlparse(raw).path or "/")
    return base, path


def _parse_postman_collection(spec: Dict) -> ParseSpecResponse:
    info = spec.get("info", {})
    title = info.get("name", "API")

    flat = _flatten_postman_items(spec.get("item", []))
    base_url = None
    endpoints = []

    for req_item in flat:
        req = req_item.get("request", {})
        method = req.get("method", "GET").upper()
        url_obj = req.get("url", {})
        item_base, path = _parse_postman_url(url_obj)
        if item_base and not base_url:
            base_url = item_base

        # Request body schema
        req_body_schema = None
        body = req.get("body") or {}
        if body.get("mode") == "raw" and body.get("raw"):
            try:
                parsed_body = json.loads(body["raw"])
                req_body_schema = _json_to_schema(parsed_body)
                # Attach example values so Generate Random returns real data
                if req_body_schema.get("type") == "object":
                    for k, v in parsed_body.items():
                        if k in req_body_schema.get("properties", {}):
                            req_body_schema["properties"][k]["example"] = v
            except Exception:
                pass

        # Query parameters
        parameters = []
        if isinstance(url_obj, dict):
            for q in url_obj.get("query", []):
                if not q.get("disabled"):
                    parameters.append({"name": q.get("key"), "in": "query",
                                       "schema": {"type": "string"},
                                       "example": q.get("value", "")})

        endpoints.append(ParsedEndpoint(
            path=path,
            method=method,
            summary=req_item.get("name", ""),
            parameters=parameters,
            request_body_schema=req_body_schema,
            tags=[],
        ))

    return ParseSpecResponse(
        title=title,
        version="1.0",
        base_url=base_url,
        endpoints=endpoints,
    )


def _resolve_ref(ref: str, spec: Dict) -> Dict:
    if not ref.startswith("#/"):
        return {}
    parts = ref[2:].split("/")
    result = spec
    for part in parts:
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(result, dict):
            result = result.get(part, {})
        else:
            return {}
    return result


def _resolve_schema(schema: Dict, spec: Dict, depth: int = 0) -> Dict:
    if depth > 8 or not isinstance(schema, dict):
        return schema
    if "$ref" in schema:
        schema = _resolve_ref(schema["$ref"], spec)
        return _resolve_schema(schema, spec, depth + 1)
    result = dict(schema)
    if "properties" in result:
        result["properties"] = {
            k: _resolve_schema(v, spec, depth + 1)
            for k, v in result["properties"].items()
        }
    if "items" in result:
        result["items"] = _resolve_schema(result["items"], spec, depth + 1)
    if "allOf" in result:
        merged: Dict = {"type": "object", "properties": {}}
        for s in result["allOf"]:
            resolved = _resolve_schema(s, spec, depth + 1)
            if "properties" in resolved:
                merged["properties"].update(resolved["properties"])
            for k, v in resolved.items():
                if k != "properties":
                    merged[k] = v
        result = merged
    return result


def _get_request_body_schema(operation: Dict, spec: Dict, ver: int) -> Optional[Dict]:
    if ver == 2:
        for param in operation.get("parameters", []):
            p = _resolve_ref(param["$ref"], spec) if "$ref" in param else param
            if p.get("in") == "body" and "schema" in p:
                return _resolve_schema(p["schema"], spec)
        return None
    rb = operation.get("requestBody", {})
    if "$ref" in rb:
        rb = _resolve_ref(rb["$ref"], spec)
    for ct in ["application/json", "application/x-www-form-urlencoded"]:
        if ct in rb.get("content", {}):
            return _resolve_schema(rb["content"][ct].get("schema", {}), spec)
    return None


def _get_response_schema(operation: Dict, spec: Dict, ver: int) -> Optional[Dict]:
    responses = operation.get("responses", {})
    for code in ["200", "201", "202"]:
        if code not in responses:
            continue
        resp = responses[code]
        if "$ref" in resp:
            resp = _resolve_ref(resp["$ref"], spec)
        if ver == 2:
            s = resp.get("schema", {})
            return _resolve_schema(s, spec) if s else None
        for ct in ["application/json"]:
            if ct in resp.get("content", {}):
                return _resolve_schema(resp["content"][ct].get("schema", {}), spec)
    return None


def _get_parameters(operation: Dict, path_item: Dict, spec: Dict) -> List[Dict]:
    params = []
    seen = set()
    for p in path_item.get("parameters", []):
        p = _resolve_ref(p["$ref"], spec) if "$ref" in p else p
        key = (p.get("name"), p.get("in"))
        seen.add(key)
        params.append(p)
    for p in operation.get("parameters", []):
        p = _resolve_ref(p["$ref"], spec) if "$ref" in p else p
        key = (p.get("name"), p.get("in"))
        if key not in seen:
            params.append(p)
    return [p for p in params if p.get("in") != "body"]


def _get_base_url(spec: Dict, ver: int) -> Optional[str]:
    if ver == 2:
        host = spec.get("host", "")
        scheme = (spec.get("schemes") or ["https"])[0]
        base = spec.get("basePath", "")
        return f"{scheme}://{host}{base}" if host else None
    servers = spec.get("servers", [])
    return servers[0].get("url") if servers else None


def parse_spec(content: str) -> ParseSpecResponse:
    try:
        spec = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        spec = yaml.safe_load(content)

    if not isinstance(spec, dict):
        raise ValueError("Invalid spec format")

    # Detect Postman Collection
    schema_url = spec.get("info", {}).get("schema", "")
    if "getpostman.com" in schema_url or "item" in spec and "info" in spec and "openapi" not in spec and "swagger" not in spec:
        return _parse_postman_collection(spec)

    ver = 2 if "swagger" in spec else 3 if "openapi" in spec else None
    if ver is None:
        raise ValueError("Not a valid OpenAPI/Swagger spec or Postman Collection")

    info = spec.get("info", {})
    endpoints = []

    for path, path_item in spec.get("paths", {}).items():
        if not isinstance(path_item, dict):
            continue
        if "$ref" in path_item:
            path_item = _resolve_ref(path_item["$ref"], spec)

        for method in ["get", "post", "put", "patch", "delete"]:
            if method not in path_item:
                continue
            op = path_item[method]
            endpoints.append(
                ParsedEndpoint(
                    path=path,
                    method=method.upper(),
                    summary=op.get("summary") or op.get("description", ""),
                    operation_id=op.get("operationId"),
                    parameters=_get_parameters(op, path_item, spec),
                    request_body_schema=_get_request_body_schema(op, spec, ver),
                    response_schema=_get_response_schema(op, spec, ver),
                    tags=op.get("tags", []),
                )
            )

    return ParseSpecResponse(
        title=info.get("title", "API"),
        version=info.get("version", "1.0"),
        base_url=_get_base_url(spec, ver),
        endpoints=endpoints,
    )

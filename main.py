from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine.chain import extract_value, inject_context, resolve_path
from engine.data_gen import generate_from_schema
from engine.executor import execute_request
from engine.spec_parser import parse_spec
from models.schemas import (
    APIConfig,
    AuthConfig,
    ChainConfig,
    ExecutionStep,
    RunRequest,
    RunResult,
    StepResult,
    ParseSpecResponse,
)

app = FastAPI(title="API Chain Tester", version="1.0.0")

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── helpers ──────────────────────────────────────────────────────────────────

def _effective_auth(api: APIConfig, global_auth: Optional[AuthConfig]) -> Optional[AuthConfig]:
    return api.auth if api.auth and api.auth.type != "none" else global_auth


def _resolve_auth(auth_template: Optional[AuthConfig], context: Dict[str, Any]) -> Optional[AuthConfig]:
    """Re-resolve {{var}} in bearer token from current context (e.g. after Auth API runs)."""
    if not auth_template or auth_template.type != "bearer":
        return auth_template
    if not auth_template.token or "{{" not in auth_template.token:
        return auth_template
    resolved = inject_context(auth_template.token, context)
    if resolved == auth_template.token:
        return auth_template
    return AuthConfig(type="bearer", token=resolved)


def _build_url(base_url: str, path: str, context: Dict[str, Any]) -> str:
    resolved_path = resolve_path(path, context)
    return base_url.rstrip("/") + resolved_path


def _make_step(
    step_label: str,
    api: APIConfig,
    method: str,
    url: str,
    body: Optional[Any],
    auth: Optional[AuthConfig],
    verify_ssl: bool,
    timeout: int,
    context: Dict[str, Any],
) -> StepResult:
    result = execute_request(
        method=method,
        url=url,
        body=body,
        headers=api.custom_headers or {},
        auth=auth,
        verify_ssl=verify_ssl,
        timeout=timeout,
    )
    extracted: Dict[str, Any] = {}
    if result["success"] and result["response_body"] is not None:
        body = result["response_body"]

        # ── Auto-extract ALL scalar fields from response ──────────────────────
        # Makes every field available as api1_fieldName in subsequent requests
        if isinstance(body, dict):
            for field, val in body.items():
                if isinstance(val, (str, int, float, bool)) or val is None:
                    context[f"{api.id}_{field}"] = val
                    extracted[f"{api.id}_{field}"] = val

        # ── ID field shortcut ─────────────────────────────────────────────────
        id_val = extract_value(body, api.id_field)
        if id_val is not None:
            context[f"{api.id}_id"] = id_val          # ensure always set
            extracted[f"{api.id}_id"] = id_val

        # ── User-defined extracts (dot-path, nested fields) ───────────────────
        for ex in api.response_extracts:
            val = extract_value(body, ex.field)
            if val is not None:
                context[ex.as_var] = val
                extracted[ex.as_var] = val

    return StepResult(
        step=step_label,
        api_id=api.id,
        method=method,
        url=url,
        status_code=result["status_code"],
        response_body=result["response_body"],
        request_body=result["request_body"],
        request_headers=result["request_headers"],
        duration_ms=result["duration_ms"],
        success=result["success"],
        error=result["error"],
        extracted=extracted,
    )


def _run_op(
    op: str,
    api: "APIConfig",
    auth: Optional["AuthConfig"],
    chain: "ChainConfig",
    context: Dict[str, Any],
    steps: List["StepResult"],
) -> Optional["RunResult"]:
    """Execute one CRUD operation. Returns RunResult only on fatal CREATE failure."""
    if op == "create":
        if not api.post_endpoint or not api.ops.create:
            return None
        body = inject_context(api.post_body, context)
        url = _build_url(api.base_url, api.post_endpoint.path, context)
        step = _make_step(
            f"CREATE {api.name}", api, "POST", url, body,
            _effective_auth(api, auth), chain.verify_ssl, chain.timeout, context,
        )
        steps.append(step)
        if not step.success:
            return RunResult(
                success=False, steps=steps, context=context,
                error=f"CREATE failed for {api.name}: {step.error or step.status_code}",
            )

    elif op == "read":
        if not api.get_endpoint or not api.ops.read:
            return None
        url = _build_url(api.base_url, api.get_endpoint.path, context)
        if "{" in api.get_endpoint.path:
            api_id_val = context.get(f"{api.id}_id")
            if api_id_val:
                context.setdefault("id", api_id_val)
            url = _build_url(api.base_url, resolve_path(api.get_endpoint.path, context), context)
        steps.append(_make_step(
            f"READ {api.name}", api, "GET", url, None,
            _effective_auth(api, auth), chain.verify_ssl, chain.timeout, context,
        ))

    elif op == "update":
        if not api.put_endpoint or not api.ops.update:
            return None
        put_body = inject_context(
            api.put_body if api.put_body is not None else api.post_body, context,
        )
        api_id_val = context.get(f"{api.id}_id")
        if api_id_val:
            context.setdefault("id", api_id_val)
        url = _build_url(api.base_url, api.put_endpoint.path, context)
        steps.append(_make_step(
            f"UPDATE {api.name}", api, "PUT", url, put_body,
            _effective_auth(api, auth), chain.verify_ssl, chain.timeout, context,
        ))

    elif op == "delete":
        if not api.delete_endpoint or not api.ops.delete:
            return None
        api_id_val = context.get(f"{api.id}_id")
        if api_id_val:
            context["id"] = api_id_val
        url = _build_url(api.base_url, api.delete_endpoint.path, context)
        steps.append(_make_step(
            f"DELETE {api.name}", api, "DELETE", url, None,
            _effective_auth(api, auth), chain.verify_ssl, chain.timeout, context,
        ))

    return None


def _run_chain_sync(chain: ChainConfig) -> RunResult:
    context: Dict[str, Any] = {}
    steps: List[StepResult] = []
    auth = chain.auth
    api_map = {api.id: api for api in chain.apis}

    if chain.execution_steps:
        # ── Dynamic: user-configured ordered step list ────────────────────────
        for exec_step in chain.execution_steps:
            if not exec_step.enabled:
                continue
            api = api_map.get(exec_step.api_id)
            if not api:
                continue
            early = _run_op(exec_step.operation, api, auth, chain, context, steps)
            auth = _resolve_auth(chain.auth, context)
            if early is not None:
                return early
    else:
        # ── Legacy: fixed CREATE→READ→UPDATE→DELETE phases ────────────────────
        for api in chain.apis:
            early = _run_op("create", api, auth, chain, context, steps)
            auth = _resolve_auth(chain.auth, context)
            if early is not None:
                return early

        for api in chain.apis:
            _run_op("read", api, auth, chain, context, steps)

        for api in chain.apis:
            _run_op("update", api, auth, chain, context, steps)

        delete_order = chain.delete_order or [a.id for a in reversed(chain.apis)]
        for api_id in delete_order:
            api = api_map.get(api_id)
            if api:
                _run_op("delete", api, auth, chain, context, steps)

    overall = all(s.success for s in steps)
    return RunResult(success=overall, steps=steps, context=context)


# ── routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def root():
    html_file = STATIC_DIR / "index.html"
    return HTMLResponse(html_file.read_text(encoding="utf-8"))


class ParseRequest(BaseModel):
    content: str


@app.post("/api/parse-spec", response_model=ParseSpecResponse)
async def parse_spec_endpoint(req: ParseRequest):
    try:
        return parse_spec(req.content)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/generate-body")
async def generate_body(schema: Dict[str, Any]):
    """Generate random request body from JSON schema"""
    return generate_from_schema(schema)


@app.post("/api/run", response_model=RunResult)
async def run_chain(req: RunRequest):
    try:
        return _run_chain_sync(req.chain)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

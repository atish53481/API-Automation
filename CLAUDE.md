# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Non-Regression Rule

**Before implementing any new instruction**, verify that existing UI/UX, frontend behavior, and design work remain intact. Do not alter layout, styles, component structure, or visual behavior unless explicitly asked. If a change risks breaking existing design, flag it and confirm before proceeding.

## Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run dev server (auto-reload)
python main.py
# or
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

No test suite is configured. The app exposes a browser UI at `http://localhost:8000`.

## Architecture

**API Chain Tester** — FastAPI backend + vanilla JS frontend that executes ordered sequences of HTTP requests across multiple APIs, threading response values into subsequent requests.

### Request pipeline

`POST /api/run` → `main._run_chain_sync()` → iterates `ExecutionStep` list → `main._make_step()` → `engine/executor.execute_request()` (httpx) → extracts values into shared `context` dict.

### Context propagation (the core mechanism)

After each successful response, values flow into a shared `context: Dict[str, Any]`:

1. **Auto-extract**: every scalar field in the response body is stored as `{api_id}_{field}` (e.g. API id `auth` with response `{"token": "abc"}` → `context["auth_token"] = "abc"`)
2. **ID shortcut**: `id_field` (default `"id"`) is always stored as `{api_id}_id`
3. **User extracts**: `response_extracts` list with dot-path notation (`data.user.id`) stored under any variable name

That context is then injected into subsequent requests via two syntaxes:
- `{{var}}` in body/header/token strings → `engine/chain.inject_context()`
- `{param}` in URL paths → `engine/chain.resolve_path()`

### Execution modes

- **Dynamic** (`ChainConfig.execution_steps` set): runs each `ExecutionStep` in order; any step can be enabled/disabled
- **Legacy** (no `execution_steps`): fixed phases — all CREATEs → all READs → all UPDATEs → all DELETEs (delete order reversed by default, or set via `delete_order`)

### Auth resolution

Auth is re-resolved after every step (`main._resolve_auth()`), so a `bearer` token with `{{auth_token}}` placeholder works even if the auth API runs as the first step in the chain.

Per-API auth overrides global chain auth via `APIConfig.auth`; falls back to `ChainConfig.auth` if per-API auth is absent or `"none"`.

### Module map

| Module | Responsibility |
|---|---|
| `main.py` | FastAPI app, route handlers, chain execution orchestration |
| `engine/chain.py` | `extract_value` (dot-path / JSONPath), `inject_context` (`{{var}}`), `resolve_path` (`{param}`) |
| `engine/executor.py` | httpx HTTP client; builds auth headers/params; returns normalized result dict |
| `engine/spec_parser.py` | Parses OpenAPI v2/v3 (JSON or YAML) and Postman Collection v2.0/v2.1 into `ParseSpecResponse` |
| `engine/data_gen.py` | Generates random request bodies from JSON Schema; uses Faker when available |
| `models/schemas.py` | All Pydantic models (`ChainConfig`, `APIConfig`, `StepResult`, `RunResult`, etc.) |
| `static/` | Single-page frontend (index.html + app.js + style.css) |

### Key Pydantic models

- `ChainConfig` — top-level run config: list of `APIConfig`, global auth, SSL, timeout, optional `execution_steps`
- `APIConfig` — one API endpoint group: base URL, per-verb endpoints, bodies, `response_extracts`, per-API auth/headers, `ops` toggles
- `ExecutionStep` — references an `api_id` + `operation` (`create`/`read`/`update`/`delete`)
- `StepResult` — result of one HTTP call including request/response bodies, headers, duration, extracted values
- `RunResult` — aggregated result: overall success, all steps, final context state

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

## Cache Busting

`static/index.html` loads `app.js` and `style.css` with a `?v=N` version suffix (e.g. `?v=21`). **Always bump N** when editing either file — browser caches the old version otherwise. Hard-refresh (`Ctrl+Shift+R`) required after server restart.

## Architecture

**API Chain Tester** — FastAPI backend + vanilla JS SPA (no framework) that executes ordered sequences of HTTP requests across multiple APIs, threading response values into subsequent requests.

### Request pipeline

`POST /api/run` → `main._run_chain_sync()` → iterates `ExecutionStep` list → `main._make_step()` → `engine/executor.execute_request()` (httpx) → extracts values into shared `context` dict.

### Context propagation (the core mechanism)

After each successful response, values flow into a shared `context: Dict[str, Any]`:

1. **Auto-extract**: every scalar field in the response body stored as `{api_id}_{field}` (e.g. API id `auth` + response `{"token":"abc"}` → `context["auth_token"] = "abc"`)
2. **ID shortcut**: `id_field` (default `"id"`) always stored as `{api_id}_id`
3. **User extracts**: `response_extracts` list with dot-path notation (`data.user.id`) stored under any variable name

Context injection syntaxes:
- `{{var}}` in body / header values / bearer token → `engine/chain.inject_context()` (recursive, handles dict/list)
- `{param}` in URL paths → `engine/chain.resolve_path()`

**Critical**: `api.custom_headers` values are resolved through `inject_context` in `main._make_step()` before being passed to the executor. This enables `Cookie: token={{auth_token}}` patterns.

### Execution modes

- **Dynamic** (`ChainConfig.execution_steps` set): runs each `ExecutionStep` in order; any step can be enabled/disabled
- **Legacy** (no `execution_steps`): fixed phases — all CREATEs → all READs → all UPDATEs → all DELETEs (reversed by default, or set via `delete_order`)

### Auth resolution

Auth is re-resolved after every step (`main._resolve_auth()`), so `{{auth_token}}` in a bearer token resolves correctly even when the auth API runs as step 1.

Per-API auth (`APIConfig.auth`) overrides global chain auth (`ChainConfig.auth`); falls back to global if per-API auth is absent or `"none"`.

### Module map

| Module | Responsibility |
|---|---|
| `main.py` | FastAPI app, route handlers, chain execution orchestration |
| `engine/chain.py` | `extract_value` (dot-path/JSONPath), `inject_context` (`{{var}}`), `resolve_path` (`{param}`) |
| `engine/executor.py` | httpx HTTP client; builds auth headers/params; returns normalized result dict |
| `engine/spec_parser.py` | Parses OpenAPI v2/v3 (JSON or YAML) and Postman Collection v2.0/v2.1 into `ParseSpecResponse` |
| `engine/data_gen.py` | Generates random request bodies from JSON Schema; uses Faker when available |
| `models/schemas.py` | All Pydantic models |
| `static/` | SPA: `index.html` + `app.js` + `style.css` |

### Key Pydantic models

- `ChainConfig` — top-level run config: list of `APIConfig`, global auth, SSL, timeout, optional `execution_steps`
- `APIConfig` — one API group: base URL, per-verb endpoints, bodies, `response_extracts`, per-API `auth`, `custom_headers`, `ops` toggles
- `ExecutionStep` — `{api_id, operation: "create"|"read"|"update"|"delete", enabled}`
- `StepResult` — one HTTP call result: request/response bodies, headers, duration, `extracted` vars
- `RunResult` — aggregated: overall success, all steps, final context state

### Frontend state (app.js)

Key `state` fields that drive the UI and `buildChainConfig()`:

| Field | Purpose |
|---|---|
| `state.apis[]` | `{id, name, baseUrl, endpoints[]}` — discovered from spec |
| `state.apiOps[apiId]` | `{create, read, update, delete}` booleans — auto-derived from which endpoints exist in spec |
| `state.apiAuth[apiId]` | Per-API auth override `{type, token, username, password, key_name, key_value, key_in}` |
| `state.apiHeaders[apiId]` | Custom headers object for each API |
| `state.postBodies[apiId]` | POST body dict |
| `state.putBodies[apiId]` | PUT body dict (falls back to POST body) |
| `state.executionSteps[]` | `{uid, apiId, operation, enabled}` — ordered execution list |
| `state._authTokenVar` | Variable name of the auth token (e.g. `"auth_token"`) for quick-fix features |

Ops are **spec-driven**: `_autoBootstrapFromSpec()` only enables operations that have actual endpoints in the parsed spec. Never force CRUD operations that the spec doesn't define.

### Key frontend functions

- `buildChainConfig()` — assembles `ChainConfig` from all state, sent to `POST /api/run`
- `_autoBootstrapFromSpec()` — populates `state.apis`, `state.apiOps`, `state._authTokenVar` from parsed spec
- `renderRunPage()` — renders reorderable step list + calls `_renderWorkflowPreview()`
- `_renderWorkflowPreview(steps)` — numbered preview of execution order with phase dividers, captured-var annotations, path-param usage, and skipped-step indicators
- `renderStep(step, i)` — structured inspect panel: WHAT HAPPENED / ROOT CAUSE / REQUEST / RESPONSE / VARIABLES / cURL copy button; failed steps open by default
- `quickFixCookieAuth(apiId)` — one-click adds `Cookie: token={{auth_token}}` to custom headers (shown when step returns 403)

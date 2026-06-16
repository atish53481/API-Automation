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

# Deploy to Vercel (production)
vercel --prod --yes
```

No test suite is configured. The app exposes a browser UI at `http://localhost:8000`.  
Production URL: `https://api-chain-tester.vercel.app`

## Cache Busting

`static/index.html` loads `app.js` and `style.css` with a `?v=N` version suffix (currently `?v=30`). **Always bump N** when editing either file — browser caches the old version otherwise.

## Architecture

**API Chain Tester** — FastAPI backend + vanilla JS SPA (no framework) that executes ordered sequences of HTTP requests across multiple APIs, threading response values into subsequent requests.

### Request pipeline

`POST /api/run` → `main._run_chain_sync()` → iterates `ExecutionStep` list → `main._make_step()` → `engine/executor.execute_request()` (httpx) → extracts values into shared `context` dict.

### Context propagation (the core mechanism)

After each successful response, values flow into a shared `context: Dict[str, Any]`:

1. **Auto-extract**: every scalar field in the response body stored as `{api_id}_{field}`
2. **ID shortcut**: `id_field` (default `"id"`) always stored as `{api_id}_id`
3. **User extracts**: `response_extracts` list with dot-path notation stored under any variable name

Context injection syntaxes:
- `{{var}}` in body / header values / bearer token → `engine/chain.inject_context()` (recursive, handles dict/list)
- `{param}` in URL paths → `engine/chain.resolve_path()`

**Critical**: `api.custom_headers` values are resolved through `inject_context` in `main._make_step()` before being passed to the executor. This enables `Cookie: token={{auth_token}}` patterns.

### Execution modes

- **Dynamic** (`ChainConfig.execution_steps` set): runs each `ExecutionStep` in order; any step can be enabled/disabled
- **Legacy** (no `execution_steps`): fixed phases — all CREATEs → all READs → all UPDATEs → all DELETEs (reversed)

### Auth resolution

Auth is re-resolved after every step (`main._resolve_auth()`), so `{{auth_token}}` in a bearer token resolves correctly even when the auth API runs as step 1.

Per-API auth (`APIConfig.auth`) overrides global chain auth (`ChainConfig.auth`); falls back to global if per-API auth is absent or `"none"`.

OAuth 2.0: `engine/executor.fetch_oauth2_token(auth)` is called in `_run_chain_sync()` before the chain starts. The fetched token is stored as `context["oauth2_access_token"]` and injected as Bearer into all subsequent requests. Supports `client_credentials` and `password` grant types.

### Resource grouping (`groupByResource`)

Uses `ep.tags[0]` from OpenAPI spec as the authoritative resource name. Falls back to first non-version, non-param path segment when tags are absent. Version prefixes (`/api`, `/v1`, `/rest`) are skipped via regex. This drives how endpoints are grouped into API panels on the Configure Chain page.

### Spec parser

`engine/spec_parser.py` handles OpenAPI v2/v3 (JSON or YAML) and Postman Collection v2.0/v2.1. Content-type matching uses `startswith()` prefix match (not exact equality) to handle versioned types like `application/json; v=1.0`.

### Module map

| Module | Responsibility |
|---|---|
| `main.py` | FastAPI app, HTTP access logging middleware, route handlers, chain execution orchestration |
| `engine/chain.py` | `extract_value` (dot-path/JSONPath), `inject_context` (`{{var}}`), `resolve_path` (`{param}`) |
| `engine/executor.py` | httpx HTTP client; `execute_request()` builds auth headers/params; `fetch_oauth2_token()` for OAuth2 pre-fetch |
| `engine/spec_parser.py` | Parses OpenAPI v2/v3 and Postman Collection into `ParseSpecResponse` |
| `engine/data_gen.py` | Generates random request bodies from JSON Schema; uses Faker when available |
| `models/schemas.py` | All Pydantic models; `AuthConfig` includes oauth2 fields |
| `static/` | SPA: `index.html` + `app.js` + `style.css` |
| `vercel.json` | Vercel deployment config — routes all requests through `main.py` via `@vercel/python` |

### Key Pydantic models

- `ChainConfig` — top-level run config: list of `APIConfig`, global auth, SSL, timeout, optional `execution_steps`
- `APIConfig` — one API group: base URL, per-verb endpoints, bodies, `response_extracts`, per-API `auth`, `custom_headers`, `ops` toggles
- `AuthConfig` — `type` ∈ `{none, bearer, basic, api_key, oauth2}`; oauth2 fields: `oauth2_grant_type`, `oauth2_token_url`, `oauth2_client_id`, `oauth2_client_secret`, `oauth2_scope`, `oauth2_username`, `oauth2_password`
- `ExecutionStep` — `{api_id, operation: "create"|"read"|"update"|"delete", enabled}`
- `StepResult` — one HTTP call result: request/response bodies, headers, duration, `extracted` vars
- `RunResult` — aggregated: overall success, all steps, final context state

### Frontend state (app.js)

Key `state` fields that drive the UI and `buildChainConfig()`:

| Field | Purpose |
|---|---|
| `state.apis[]` | `{id, name, baseUrl, endpoints[]}` — discovered from spec |
| `state.apiOps[apiId]` | `{create, read, update, delete}` booleans — spec-driven, never forced |
| `state.apiAuth[apiId]` | Per-API auth override |
| `state.apiHeaders[apiId]` | Custom headers object for each API |
| `state.postFields[apiId]` | `[{name, type, value, random, dateFormat?}]` — POST body fields; `dateFormat` set on date-detected fields |
| `state.putFields[apiId]` | Same structure as postFields, for PUT body |
| `state.baseUrls[apiId]` | Per-API base URL; seeded from global base URL card or `spec.base_url` |
| `state.executionSteps[]` | `{uid, apiId, operation, enabled}` — ordered execution list |
| `state._authTokenVar` | Variable name of the auth token for quick-fix features |

Ops are **spec-driven**: `_autoBootstrapFromSpec()` only enables operations that have actual endpoints in the parsed spec.

### Date field detection

`_isDateField(name)` splits camelCase (e.g. `bookingDate` → `booking Date`) and tests against keywords: `date, dob, birth, creat, updat, modif, start, end, expir, issu, due, sent, receiv, timestamp`. Also triggered by OpenAPI `format: date` or `format: date-time`. Detected fields get `dateFormat: 'YYYY-MM-DD'` and today's date as default value — no manual input needed. `DATE_FORMATS` array holds 16 formats; `_applyDateFmt(fmt, randomize)` produces the formatted string.

### Key frontend functions

- `buildChainConfig()` — assembles `ChainConfig` from all state, sent to `POST /api/run`
- `_autoBootstrapFromSpec()` — populates `state.apis`, `state.apiOps`, `state.baseUrls`, `state._authTokenVar` from parsed spec
- `applyGlobalBaseUrl(url)` — propagates a single URL to all `state.baseUrls` and live DOM inputs; called on render if `spec.base_url` exists
- `renderChainPage()` — renders Global Base URL card (auto-fills from spec, shows ✓/⚠ hint) + API panels
- `onDateFormatChange(apiId, idx, fmt, isPut)` — updates `f.dateFormat`, recomputes `f.value`, syncs DOM input
- `saveSession()` / `_applySession(data)` — full round-trip JSON: serializes all state + auth DOM values; restores on load, skipping re-import
- `toggleTheme()` — toggles `body.light-mode` class; persists to `localStorage` key `act-theme`
- `renderStep(step, i)` — structured inspect panel: WHAT HAPPENED / ROOT CAUSE / REQUEST / RESPONSE / VARIABLES / cURL copy; failed steps open by default
- `quickFixCookieAuth(apiId)` — one-click adds `Cookie: token={{auth_token}}` to custom headers (shown on 403)

### Browser run mode (Cloudflare bypass)

The Run page has a **Run via** selector (`#run-mode-select`):
- **Server** (default): `POST /api/run` → Vercel backend → httpx. Fast, but blocked by Cloudflare managed challenge on some APIs.
- **Browser**: skips the backend entirely; runs via `fetch()` from the user's real browser. Passes Cloudflare bot detection because the request originates from a real browser with correct TLS fingerprint and JS execution.

JS functions for browser mode (all in `app.js`):
- `_runStepsClientSide(chain)` — iterates `chain.execution_steps`, calls `fetch()` per step, propagates context, returns a `RunResult`-shaped object fed into the same `renderResults()` UI
- `_cInject(val, ctx)` — JS equivalent of `inject_context`: replaces `{{var}}` recursively in strings/objects/arrays
- `_cResolvePath(path, ctx)` — JS equivalent of `resolve_path`: replaces `{param}` in URL paths
- `_cDotGet(obj, path)` — dot-path value extraction (e.g. `data.user.id`)
- `_cAuthHeaders(auth)` — builds `Authorization` header from auth config (Bearer/Basic/API Key)

### Outgoing request headers (`engine/executor.py`)

All server-side requests sent with Chrome browser User-Agent + `Accept-Language: en-US,en;q=0.9` to avoid basic bot detection. `httpx.Client` uses `follow_redirects=True`. Cloudflare managed challenge (TLS fingerprint + JS challenge) still blocks server-mode; use Browser mode for Cloudflare-protected APIs.

### Access logging (Vercel)

`main.py` has an HTTP middleware that logs every request: `ip`, `method`, `path`, `status`, `duration`, `user-agent`. Real IP extracted from `X-Forwarded-For` (set by Vercel). View logs in Vercel dashboard → Functions tab, or via `vercel logs api-chain-tester.vercel.app --follow`.

import base64
import time
from typing import Any, Dict, Optional

import httpx

from models.schemas import AuthConfig


def _auth_headers(auth: Optional[AuthConfig]) -> Dict[str, str]:
    if not auth or auth.type == "none":
        return {}
    if auth.type == "bearer":
        return {"Authorization": f"Bearer {auth.token or ''}"}
    if auth.type == "basic":
        creds = base64.b64encode(f"{auth.username}:{auth.password}".encode()).decode()
        return {"Authorization": f"Basic {creds}"}
    if auth.type == "api_key" and auth.key_in == "header":
        return {auth.key_name: auth.key_value}
    return {}


def _auth_params(auth: Optional[AuthConfig]) -> Dict[str, str]:
    if auth and auth.type == "api_key" and auth.key_in == "query":
        return {auth.key_name: auth.key_value}
    return {}


def fetch_oauth2_token(auth: "AuthConfig", verify_ssl: bool = True, timeout: int = 30) -> str:
    """POST to token_url with client credentials or password grant; returns access_token string."""
    if not auth.oauth2_token_url:
        raise ValueError("OAuth2 token URL is required")
    payload: Dict[str, str] = {
        "grant_type":    auth.oauth2_grant_type or "client_credentials",
        "client_id":     auth.oauth2_client_id     or "",
        "client_secret": auth.oauth2_client_secret or "",
    }
    if auth.oauth2_scope:
        payload["scope"] = auth.oauth2_scope
    if (auth.oauth2_grant_type or "client_credentials") == "password":
        payload["username"] = auth.oauth2_username or ""
        payload["password"] = auth.oauth2_password or ""

    with httpx.Client(verify=verify_ssl, timeout=timeout) as client:
        resp = client.post(
            auth.oauth2_token_url,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
        token = data.get("access_token") or data.get("token") or data.get("id_token")
        if not token:
            raise ValueError(f"No access_token in OAuth2 response: {list(data.keys())}")
        return str(token)


def execute_request(
    method: str,
    url: str,
    body: Optional[Any] = None,
    headers: Optional[Dict[str, str]] = None,
    params: Optional[Dict[str, str]] = None,
    auth: Optional[AuthConfig] = None,
    verify_ssl: bool = True,
    timeout: int = 30,
) -> Dict[str, Any]:
    all_headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        **_auth_headers(auth),
        **(headers or {}),
    }
    all_params = {**_auth_params(auth), **(params or {})}
    send_body = body if method.upper() in ("POST", "PUT", "PATCH") and body is not None else None

    t0 = time.monotonic()
    try:
        with httpx.Client(verify=verify_ssl, timeout=timeout) as client:
            resp = client.request(
                method=method.upper(),
                url=url,
                json=send_body,
                headers=all_headers,
                params=all_params,
            )
        ms = round((time.monotonic() - t0) * 1000, 2)
        try:
            resp_body = resp.json()
        except Exception:
            resp_body = resp.text
        return {
            "status_code": resp.status_code,
            "response_body": resp_body,
            "duration_ms": ms,
            "success": 200 <= resp.status_code < 300,
            "error": None,
            "request_headers": dict(all_headers),
            "request_body": send_body,
        }
    except httpx.TimeoutException:
        ms = round((time.monotonic() - t0) * 1000, 2)
        return {"status_code": None, "response_body": None, "duration_ms": ms,
                "success": False, "error": f"Timeout after {timeout}s",
                "request_headers": dict(all_headers), "request_body": send_body}
    except Exception as exc:
        ms = round((time.monotonic() - t0) * 1000, 2)
        return {"status_code": None, "response_body": None, "duration_ms": ms,
                "success": False, "error": str(exc),
                "request_headers": dict(all_headers), "request_body": send_body}

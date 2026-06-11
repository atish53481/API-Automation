from pydantic import BaseModel
from typing import Any, Dict, List, Optional, Literal


class AuthConfig(BaseModel):
    type: Literal["none", "bearer", "basic", "api_key"] = "none"
    token: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    key_name: Optional[str] = None
    key_value: Optional[str] = None
    key_in: Optional[Literal["header", "query"]] = "header"


class EndpointRef(BaseModel):
    path: str
    method: str = "POST"


class ResponseExtract(BaseModel):
    field: str       # dot notation path in response: "id", "data.userId"
    as_var: str      # variable name stored in context: "api1_id"


class OpsConfig(BaseModel):
    create: bool = True
    read:   bool = True
    update: bool = True
    delete: bool = True


class APIConfig(BaseModel):
    id: str
    name: str
    base_url: str
    post_endpoint:   Optional[EndpointRef] = None
    get_endpoint:    Optional[EndpointRef] = None
    put_endpoint:    Optional[EndpointRef] = None
    delete_endpoint: Optional[EndpointRef] = None
    post_body: Dict[str, Any] = {}
    put_body:  Optional[Dict[str, Any]] = None
    id_field: str = "id"
    response_extracts: List[ResponseExtract] = []
    auth: Optional[AuthConfig] = None           # per-API auth override
    custom_headers: Dict[str, str] = {}         # extra request headers
    ops: OpsConfig = OpsConfig()                # toggle CRUD operations
    path_params: Dict[str, str] = {}


class ExecutionStep(BaseModel):
    api_id: str
    operation: Literal["create", "read", "update", "delete"]
    enabled: bool = True


class ChainConfig(BaseModel):
    auth: Optional[AuthConfig] = None
    apis: List[APIConfig]
    delete_order: Optional[List[str]] = None    # api ids in delete order
    verify_ssl: bool = True
    timeout: int = 30
    execution_steps: Optional[List[ExecutionStep]] = None


class RunRequest(BaseModel):
    chain: ChainConfig


class StepResult(BaseModel):
    step: str
    api_id: str
    method: str
    url: str
    status_code: Optional[int] = None
    response_body: Optional[Any] = None
    request_body: Optional[Any] = None
    request_headers: Optional[Dict[str, str]] = None
    duration_ms: Optional[float] = None
    success: bool = False
    error: Optional[str] = None
    extracted: Dict[str, Any] = {}


class RunResult(BaseModel):
    success: bool
    steps: List[StepResult]
    context: Dict[str, Any] = {}
    error: Optional[str] = None


class ParsedEndpoint(BaseModel):
    path: str
    method: str
    summary: Optional[str] = None
    operation_id: Optional[str] = None
    parameters: List[Dict[str, Any]] = []
    request_body_schema: Optional[Dict[str, Any]] = None
    response_schema: Optional[Dict[str, Any]] = None
    tags: List[str] = []


class ParseSpecResponse(BaseModel):
    title: str
    version: str
    base_url: Optional[str] = None
    endpoints: List[ParsedEndpoint]

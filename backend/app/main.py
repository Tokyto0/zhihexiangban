"""Small, dependency-free HTTP API for the MVP.

This module provides the first end-to-end slice requested by the product
document: health, project CRUD, deterministic offline analysis, and Markdown /
JSON report export.  It uses only Python's standard library, so a fresh machine
can run the Mock provider without an API key or a database.  The storage layer
is intentionally isolated behind :class:`JsonStore`; it can be replaced by the
SQLAlchemy repository when the PostgreSQL deployment is introduced.

Run from the repository root with::

    python backend/run.py

The API listens on ``http://127.0.0.1:8000`` by default.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


def load_local_env() -> None:
    """Load simple KEY=value pairs from a local .env without logging values."""

    env_path = Path(__file__).resolve().parents[2] / ".env"
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_local_env()

API_PREFIX = "/api/v1"
DISCLAIMER = "本结果仅用于信息整理和风险初筛，不构成法律意见。"
KB_VERSION = os.getenv("KNOWLEDGE_BASE_VERSION", "seed-v1")
MODEL_VERSION = "mock-v1"
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
DEFAULT_KB_PATH = Path(__file__).resolve().parents[2] / "data" / "seeds" / "knowledge" / "seed-v1.jsonl"
DEFAULT_SOURCE_REGISTRY_PATH = Path(__file__).resolve().parents[2] / "data" / "source_registry" / "sources.jsonl"
SUPPORTED_RIGHT_TYPES = ("trademark", "copyright", "geographical_indication")
SUPPORTED_ASSET_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "image/png",
    "image/jpeg",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def request_id() -> str:
    return f"req-{uuid.uuid4().hex[:12]}"


class ApiError(Exception):
    """Expected user-facing API error."""

    def __init__(self, status: int, code: str, message: str, details: Any | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def error_payload(exc: ApiError, req_id: str) -> dict[str, Any]:
    return {
        "code": exc.code,
        "message": exc.message,
        "details": exc.details,
        "request_id": req_id,
    }


def as_text(value: Any, default: str = "") -> str:
    return str(value).strip() if value is not None else default


def validate_privacy(value: Any) -> str:
    privacy = as_text(value, "local_only")
    if privacy not in {"local_only", "external_allowed"}:
        raise ApiError(422, "VALIDATION_ERROR", "privacy_level 必须为 local_only 或 external_allowed", {"field": "privacy_level"})
    return privacy


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def parse_json_bytes(raw: bytes) -> dict[str, Any]:
    if not raw.strip():
        return {}
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ApiError(400, "INVALID_JSON", "请求体必须是合法 JSON") from exc
    if not isinstance(value, dict):
        raise ApiError(422, "VALIDATION_ERROR", "请求体必须是 JSON 对象")
    return value


class JsonStore:
    """Thread-safe local persistence used by the offline MVP.

    The file is created lazily.  A custom ``MVP_STORE_PATH`` can point to a
    temporary file in tests or a mounted data directory in Docker.
    """

    def __init__(self, path: str | Path | None = None):
        default_path = Path(__file__).resolve().parents[2] / "data" / "mvp_store.json"
        self.path = Path(path or os.getenv("MVP_STORE_PATH", str(default_path)))
        self.lock = threading.RLock()
        self.data: dict[str, Any] = {"projects": {}, "tasks": {}, "reports": {}, "assets": {}, "usage": {}}
        self._load()

    def _load(self) -> None:
        with self.lock:
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                self.data = {"projects": {}, "tasks": {}, "reports": {}, "assets": {}, "usage": {}}
            for key in ("projects", "tasks", "reports", "assets", "usage"):
                self.data.setdefault(key, {})

    def flush(self) -> None:
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(self.path.suffix + ".tmp")
            temp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
            temp.replace(self.path)

    def put(self, collection: str, key: str, value: dict[str, Any]) -> None:
        with self.lock:
            self.data[collection][key] = value
            self.flush()

    def get(self, collection: str, key: str) -> dict[str, Any] | None:
        with self.lock:
            value = self.data.get(collection, {}).get(key)
            return dict(value) if isinstance(value, dict) else None

    def values(self, collection: str) -> list[dict[str, Any]]:
        with self.lock:
            return [dict(value) for value in self.data.get(collection, {}).values()]

    def delete(self, collection: str, key: str) -> None:
        with self.lock:
            self.data.get(collection, {}).pop(key, None)
            self.flush()


STORE = JsonStore()


def provider_name() -> str:
    return os.getenv("MODEL_PROVIDER", "mock").strip().lower() or "mock"


def external_consent_granted(project: dict[str, Any]) -> bool:
    service_allowed = os.getenv("EXTERNAL_LLM_ALLOWED", "false").strip().lower() == "true"
    return service_allowed and project.get("privacy_level") == "external_allowed" and bool(project.get("external_llm_consent"))


def require_external_consent(project: dict[str, Any]) -> None:
    if os.getenv("EXTERNAL_LLM_ALLOWED", "false").strip().lower() != "true":
        raise ApiError(403, "EXTERNAL_LLM_DISABLED", "服务端未开启第三方外发，请先在后端环境配置 EXTERNAL_LLM_ALLOWED=true")
    if project.get("privacy_level") != "external_allowed" or not project.get("external_llm_consent"):
        raise ApiError(403, "EXTERNAL_CONSENT_REQUIRED", "当前项目未同意将脱敏字段发送到 DeepSeek，请先将隐私级别设为 external_allowed 并完成项目级同意")


def sanitize_external_text(value: Any) -> str:
    """Remove common personal data and credential-shaped strings before egress."""

    text = as_text(value)
    text = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "[REDACTED_KEY]", text)
    text = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[REDACTED_EMAIL]", text)
    text = re.sub(r"(?<!\d)1[3-9]\d{9}(?!\d)", "[REDACTED_PHONE]", text)
    return text[:4000]


def load_jsonl_records(path_value: str | Path) -> list[dict[str, Any]]:
    """Load a bounded JSONL file without logging its contents."""

    try:
        lines = Path(path_value).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    records: list[dict[str, Any]] = []
    for line in lines[:20000]:
        try:
            value = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def load_source_registry() -> dict[str, dict[str, Any]]:
    registry: dict[str, dict[str, Any]] = {}
    for record in load_jsonl_records(os.getenv("SOURCE_REGISTRY_PATH", str(DEFAULT_SOURCE_REGISTRY_PATH))):
        source_id = as_text(record.get("source_id"))
        if source_id:
            registry[source_id] = record
    return registry


KNOWLEDGE_ENTRIES = load_jsonl_records(os.getenv("KNOWLEDGE_BASE_PATH", str(DEFAULT_KB_PATH)))
SOURCE_REGISTRY = load_source_registry()


def knowledge_base_sources(project: dict[str, Any]) -> list[dict[str, Any]]:
    """Project-safe evidence views over the local, versioned JSONL knowledge base."""

    sources: list[dict[str, Any]] = []
    for entry in KNOWLEDGE_ENTRIES:
        source_id = as_text(entry.get("source_id") or entry.get("id"))
        text = sanitize_external_text(entry.get("text") or entry.get("excerpt"))
        if not source_id or not text:
            continue
        registry = SOURCE_REGISTRY.get(source_id, {})
        sources.append({
            "id": f"kb-{source_id}",
            "title": as_text(entry.get("title"), as_text(registry.get("title"), "本地知识库条目")),
            "publisher": as_text(entry.get("publisher"), as_text(registry.get("publisher"), "本地知识库资料")),
            "url": as_text(entry.get("url"), as_text(registry.get("url"))),
            "excerpt": text,
            "reason": "本地知识库召回，仍需结合来源状态人工核验",
            "source_type": "knowledge_base",
            "status": as_text(entry.get("status"), as_text(registry.get("status"), "pending")),
            "published_at": entry.get("effective_date") or registry.get("published_at"),
            "retrieved_at": entry.get("retrieved_at") or registry.get("retrieved_at"),
            "region": as_text(entry.get("region"), as_text(project.get("region"), "中国")),
            "right_type": as_text(entry.get("right_type"), "unknown"),
            "page_no": entry.get("page_no"),
            "knowledge_base_version": KB_VERSION,
        })
    return sources


def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


def price_config() -> dict[str, Any]:
    return {
        "version": os.getenv("DEEPSEEK_PRICING_VERSION", "2026-10-06-reference"),
        "input_per_million": float(os.getenv("DEEPSEEK_INPUT_CNY_PER_MILLION", "1")),
        "output_per_million": float(os.getenv("DEEPSEEK_OUTPUT_CNY_PER_MILLION", "4")),
    }


def estimate_cost(prompt_tokens: int, completion_tokens: int) -> float:
    pricing = price_config()
    return round((prompt_tokens / 1_000_000) * pricing["input_per_million"] + (completion_tokens / 1_000_000) * pricing["output_per_million"], 8)


def usage_cost(project_id: str | None = None, period: str | None = None) -> float:
    records = STORE.values("usage")
    now = datetime.now(timezone.utc)
    total = 0.0
    for record in records:
        if record.get("status") != "succeeded":
            continue
        if project_id and record.get("project_id") != project_id:
            continue
        created = as_text(record.get("created_at"))
        if period and created:
            if period == "day" and created[:10] != now.strftime("%Y-%m-%d"):
                continue
            if period == "month" and created[:7] != now.strftime("%Y-%m"):
                continue
        total += float(record.get("actual_cost", record.get("estimated_cost", 0)) or 0)
    return round(total, 8)


def enforce_budget(project_id: str, estimated: float) -> None:
    request_limit = float(os.getenv("DEEPSEEK_REQUEST_BUDGET_CNY", "0.05"))
    project_limit = float(os.getenv("DEEPSEEK_PROJECT_BUDGET_CNY", "0.20"))
    daily_limit = float(os.getenv("DEEPSEEK_DAILY_BUDGET_CNY", "1.00"))
    monthly_limit = float(os.getenv("DEEPSEEK_MONTHLY_BUDGET_CNY", "20.00"))
    if estimated > request_limit or estimated + usage_cost(project_id=project_id) > project_limit or estimated + usage_cost(period="day") > daily_limit or estimated + usage_cost(period="month") > monthly_limit:
        raise ApiError(402, "BUDGET_EXCEEDED", "DeepSeek 调用超过当前预算闸门", {"estimated_cost": estimated, "request_budget": request_limit, "project_cost": usage_cost(project_id=project_id), "project_budget": project_limit, "daily_cost": usage_cost(period="day"), "daily_budget": daily_limit, "monthly_cost": usage_cost(period="month"), "monthly_budget": monthly_limit})


def record_usage(project_id: str, request_id_value: str, usage: dict[str, Any], estimated_cost_value: float, status: str, error_code: str | None = None, operation: str = "analysis") -> dict[str, Any]:
    prompt_tokens = int(usage.get("prompt_tokens", 0) or 0)
    completion_tokens = int(usage.get("completion_tokens", 0) or 0)
    cached_tokens = int(usage.get("cached_tokens", usage.get("prompt_cache_hit_tokens", 0)) or 0)
    total_tokens = int(usage.get("total_tokens", prompt_tokens + completion_tokens) or 0)
    actual = estimate_cost(prompt_tokens, completion_tokens) if status == "succeeded" else 0.0
    record = {"id": new_id("usage"), "request_id": request_id_value, "project_id": project_id, "operation": operation, "provider": "deepseek", "model_requested": DEEPSEEK_MODEL, "model_served": usage.get("model", DEEPSEEK_MODEL), "status": status, "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "cached_tokens": cached_tokens, "total_tokens": total_tokens, "estimated_cost": estimated_cost_value, "actual_cost": actual, "currency": "CNY", "pricing_version": price_config()["version"], "error_code": error_code, "created_at": now_iso()}
    STORE.put("usage", record["id"], record)
    return record


def deepseek_json(messages: list[dict[str, str]], project_id: str, request_id_value: str, max_tokens: int | None = None, operation: str = "analysis") -> tuple[dict[str, Any], dict[str, Any]]:
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise ApiError(503, "PROVIDER_NOT_CONFIGURED", "DeepSeek provider 未配置 API Key，请仅在后端环境变量中设置 DEEPSEEK_API_KEY")
    base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or parsed.hostname != "api.deepseek.com":
        raise ApiError(500, "PROVIDER_ENDPOINT_BLOCKED", "DeepSeek endpoint 不在允许的安全白名单内")
    payload_text = json.dumps({"model": DEEPSEEK_MODEL, "messages": messages, "response_format": {"type": "json_object"}, "thinking": {"type": "disabled"}, "reasoning_effort": "none", "max_tokens": max_tokens or int(os.getenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "1200"))}, ensure_ascii=False)
    prompt_tokens = estimate_tokens(payload_text)
    output_limit = max_tokens or int(os.getenv("DEEPSEEK_MAX_OUTPUT_TOKENS", "1200"))
    estimated = estimate_cost(prompt_tokens, output_limit)
    enforce_budget(project_id, estimated)
    request = Request(f"{base_url}/chat/completions", data=payload_text.encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}, method="POST")
    timeout = float(os.getenv("DEEPSEEK_TIMEOUT_SECONDS", "45"))
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except HTTPError as exc:
        if exc.code in {401, 403}:
            code = "PROVIDER_AUTH_ERROR"
        elif exc.code == 402:
            code = "PROVIDER_BALANCE_EXHAUSTED"
        elif exc.code == 429:
            code = "PROVIDER_RATE_LIMITED"
        elif exc.code >= 500:
            code = "PROVIDER_UNAVAILABLE"
        else:
            code = "PROVIDER_REQUEST_ERROR"
        record_usage(project_id, request_id_value, {}, estimated, "failed", code, operation)
        raise ApiError(502, code, "DeepSeek 请求失败，请检查 provider 状态和预算配置") from exc
    except (URLError, TimeoutError, OSError) as exc:
        record_usage(project_id, request_id_value, {}, estimated, "failed", "PROVIDER_NETWORK_ERROR", operation)
        raise ApiError(502, "PROVIDER_NETWORK_ERROR", "无法连接 DeepSeek，请检查网络和 endpoint 配置") from exc
    try:
        response_payload = json.loads(raw.decode("utf-8"))
        message = response_payload["choices"][0]["message"]["content"]
        result = json.loads(message) if isinstance(message, str) else message
        if not isinstance(result, dict):
            raise ValueError("JSON result is not an object")
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError) as exc:
        record_usage(project_id, request_id_value, {}, estimated, "failed", "PROVIDER_INVALID_JSON", operation)
        raise ApiError(502, "PROVIDER_INVALID_JSON", "DeepSeek 返回的 JSON 结果无法解析") from exc
    usage = response_payload.get("usage") if isinstance(response_payload.get("usage"), dict) else {}
    usage = {**usage, "model": response_payload.get("model", DEEPSEEK_MODEL)}
    record_usage(project_id, request_id_value, usage, estimated, "succeeded", operation=operation)
    return result, usage


def _complete_asset_parse(task_id: str, asset_id: str, delay_seconds: float = 0.15) -> None:
    """Finish the local Mock asset parser without blocking the upload request.

    The worker only handles metadata and text parsing in this MVP.  It never
    sends the uploaded file to an external service.  State is written at both
    the running and completed phases so a browser polling ``GET /tasks/{id}``
    can show useful progress even on a local single-user install.
    """

    task = STORE.get("tasks", task_id)
    if not task or task.get("status") == "cancelled":
        return
    task.update({"status": "running", "progress": 10, "stage": "parsing", "updated_at": now_iso()})
    STORE.put("tasks", task_id, task)
    time.sleep(max(0.01, delay_seconds))
    task = STORE.get("tasks", task_id)
    asset = STORE.get("assets", asset_id)
    if not task or not asset or task.get("status") == "cancelled":
        return
    asset.update({"parse_status": "succeeded", "parsed_at": now_iso(), "parser_version": "mock-parser-v1", "progress": 100, "error_message": None})
    task.update({"status": "succeeded", "progress": 100, "stage": "completed", "error_code": None, "error_message": None, "updated_at": now_iso()})
    STORE.put("assets", asset_id, asset)
    STORE.put("tasks", task_id, task)


def _schedule_asset_parse(task_id: str, asset_id: str) -> None:
    worker = threading.Thread(target=_complete_asset_parse, args=(task_id, asset_id), name=f"mock-parse-{task_id}", daemon=True)
    worker.start()


def get_project(project_id: str) -> dict[str, Any]:
    project = STORE.get("projects", project_id)
    if not project:
        raise ApiError(404, "NOT_FOUND", "项目不存在", {"project_id": project_id})
    return project


def source_for(project: dict[str, Any], source_type: str, excerpt: str, reason: str) -> dict[str, Any]:
    source_id = new_id("source")
    return {
        "id": source_id,
        "publisher": "项目材料（用户提供）",
        "title": f"{project['name']} 项目描述",
        "url": None,
        "published_at": None,
        "retrieved_at": now_iso(),
        "status": "pending",
        "source_type": source_type,
        "excerpt": excerpt[:600],
        "reason": reason,
        "knowledge_base_version": KB_VERSION,
    }


def split_keywords(text: str) -> list[str]:
    words = re.findall(r"[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9_-]{1,30}", text)
    seen: set[str] = set()
    result: list[str] = []
    for word in words:
        if word not in seen:
            seen.add(word)
            result.append(word)
    return result[:12]


def build_analysis(project: dict[str, Any], assets: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    """Create a stable Mock-provider result with evidence on every finding."""

    description = as_text(project.get("description"))
    context = "；".join(filter(None, [project.get("name"), project.get("region"), project.get("category"), description]))
    excerpt = context or "项目尚未提供足够文字材料。"
    keywords = split_keywords(context)
    entities: list[dict[str, Any]] = []

    def add_entity(entity_type: str, value: str, confidence: float, review_status: str = "unreviewed") -> None:
        if value and not any(item["type"] == entity_type and item["value"] == value for item in entities):
            entities.append({
                "id": new_id("entity"),
                "type": entity_type,
                "value": value,
                "source_chunk_id": None,
                "confidence": confidence,
                "review_status": review_status,
            })

    add_entity("project", as_text(project.get("name")), 0.99)
    add_entity("region", as_text(project.get("region")), 0.96)
    add_entity("category", as_text(project.get("category")), 0.9)
    for keyword in keywords[:5]:
        if keyword not in {project.get("name"), project.get("region"), project.get("category")}:
            add_entity("product_or_service", keyword, 0.72)
    if assets:
        for asset in assets:
            add_entity("material", asset.get("filename", "未命名材料"), 0.88)
    while len(entities) < 5:
        add_entity("keyword", f"待核验要素 {len(entities) + 1}", 0.45, "needs_review")

    source = source_for(project, "project_material", excerpt, "项目基本信息和描述是本次 Mock 初筛的依据")
    sources = [source]
    rights = [
        {
            "id": new_id("right"),
            "right_type": "trademark",
            "reason": "项目名称、品牌元素或服务名称可能形成组合标识，建议进一步核查近似名称与类别。",
            "confidence": 0.78,
            "review_required": True,
        },
        {
            "id": new_id("right"),
            "right_type": "copyright",
            "reason": "项目描述可能包含文案、摄影、插画、路线图或其他具有表达性的素材。",
            "confidence": 0.73,
            "review_required": True,
        },
        {
            "id": new_id("right"),
            "right_type": "geographical_indication",
            "reason": "项目含有地域或产地线索时，需核对质量特征、传统工艺和官方来源。",
            "confidence": 0.58,
            "review_required": True,
        },
    ]
    findings = [
        {
            "id": new_id("finding"),
            "level": "medium",
            "type": "名称核验",
            "title": "名称或核心词待核验",
            "trigger": "名称或核心词的近似性尚未完成官方系统核验",
            "evidence_ids": [source["id"]],
            "recommendation": "拆分名称中的核心词、地域词和通用词，并通过官方查询入口做人工复核。",
            "status": "open",
            "review_required": True,
        },
        {
            "id": new_id("finding"),
            "level": "insufficient",
            "type": "材料完整性",
            "title": "作者与授权凭证待补录",
            "trigger": "项目材料未提供完整作者、来源和授权凭证字段",
            "evidence_ids": [source["id"]],
            "recommendation": "补充素材作者、来源、时间、许可证和授权凭证，再确认开放或发布范围。",
            "status": "open",
            "review_required": True,
        },
    ]
    return {
        "summary": "已完成离线 Mock 初筛，请结合证据和待核验事项进行人工复核。",
        "entities": entities,
        "right_candidates": rights,
        "sources": sources,
        "findings": findings,
        "missing_information": ["官方近似名称检索结果", "素材作者、来源、许可证和授权凭证"],
        "model_version": MODEL_VERSION,
        "knowledge_base_version": KB_VERSION,
        "generated_at": now_iso(),
        "disclaimer": DISCLAIMER,
    }


def build_deepseek_analysis(project: dict[str, Any], assets: Iterable[dict[str, Any]], request_id_value: str) -> dict[str, Any]:
    """Run the online provider on redacted, structured project metadata only."""

    asset_rows = [{"filename": sanitize_external_text(asset.get("filename")), "mime_type": asset.get("mime_type"), "source_note": sanitize_external_text(asset.get("source_note"))} for asset in assets]
    source = source_for(project, "project_material", sanitize_external_text("；".join(filter(None, [project.get("name"), project.get("region"), project.get("category"), project.get("description")])),), "DeepSeek 仅依据经过脱敏的项目字段和材料元数据生成候选线索")
    source["status"] = "pending"
    schema = '{"summary":"string","entities":[{"type":"string","value":"string","confidence":0.0,"review_status":"unreviewed"}],"right_candidates":[{"right_type":"trademark|copyright|geographical_indication","reason":"string","confidence":0.0,"review_required":true}],"findings":[{"level":"high|medium|low|insufficient","type":"string","title":"string","trigger":"string","recommendation":"string","status":"open","review_required":true}],"missing_information":["string"]}'
    system_prompt = "你是农文旅知识产权档案助手。只做信息整理和风险初筛，不给出可注册、已确权或法律确定性结论。请严格输出 JSON，不要输出 Markdown 或 reasoning_content。所有 finding 的 evidence_ids 必须只使用给定的 source_id。"
    user_payload = {"project": {"name": sanitize_external_text(project.get("name")), "region": sanitize_external_text(project.get("region")), "category": sanitize_external_text(project.get("category")), "description": sanitize_external_text(project.get("description"))}, "assets": asset_rows, "source_id": source["id"], "json_schema_example": schema}
    raw, usage = deepseek_json([{"role": "system", "content": system_prompt}, {"role": "user", "content": "请根据以下脱敏 JSON 生成结构化初筛结果。必须输出 JSON。\n" + json.dumps(user_payload, ensure_ascii=False)}], project["id"], request_id_value)
    fallback = build_analysis(project, assets)
    def confidence_value(value: Any) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return 0.5

    entities = raw.get("entities") if isinstance(raw.get("entities"), list) else fallback["entities"]
    normalized_entities = []
    for item in entities[:20]:
        if not isinstance(item, dict) or not as_text(item.get("value")):
            continue
        normalized_entities.append({"id": new_id("entity"), "type": as_text(item.get("type"), "待分类"), "value": as_text(item.get("value"))[:160], "source_chunk_id": source["id"], "confidence": confidence_value(item.get("confidence", 0.5) or 0.5), "review_status": as_text(item.get("review_status"), "unreviewed")})
    if not normalized_entities:
        normalized_entities = fallback["entities"]
    rights = raw.get("right_candidates") if isinstance(raw.get("right_candidates"), list) else fallback["right_candidates"]
    normalized_rights = [{"id": new_id("right"), "right_type": as_text(item.get("right_type")), "reason": as_text(item.get("reason")), "confidence": confidence_value(item.get("confidence", 0.5) or 0.5), "review_required": bool(item.get("review_required", True))} for item in rights if isinstance(item, dict) and as_text(item.get("right_type")) in SUPPORTED_RIGHT_TYPES]
    if not normalized_rights:
        normalized_rights = fallback["right_candidates"]
    findings = raw.get("findings") if isinstance(raw.get("findings"), list) else fallback["findings"]
    normalized_findings = []
    for item in findings[:20]:
        if not isinstance(item, dict):
            continue
        level = as_text(item.get("level"), "insufficient")
        if level not in {"high", "medium", "low", "insufficient"}:
            level = "insufficient"
        normalized_findings.append({"id": new_id("finding"), "level": level, "type": as_text(item.get("type"), "待分类"), "title": as_text(item.get("title"), "待核验风险"), "trigger": as_text(item.get("trigger"), "模型未提供触发因素"), "evidence_ids": [source["id"]], "recommendation": as_text(item.get("recommendation"), "补充材料并进行人工核验。"), "status": as_text(item.get("status"), "open"), "review_required": True})
    if not normalized_findings:
        normalized_findings = fallback["findings"]
    missing = raw.get("missing_information") if isinstance(raw.get("missing_information"), list) else fallback["missing_information"]
    return {"summary": as_text(raw.get("summary"), fallback["summary"]), "entities": normalized_entities, "right_candidates": normalized_rights, "sources": [source], "findings": normalized_findings, "missing_information": [as_text(item) for item in missing if as_text(item)], "model_version": usage.get("model", DEEPSEEK_MODEL), "knowledge_base_version": KB_VERSION, "generated_at": now_iso(), "provider": "deepseek", "disclaimer": DISCLAIMER}


def analysis_for_project(project: dict[str, Any]) -> dict[str, Any]:
    analysis = project.get("analysis")
    if isinstance(analysis, dict) and analysis.get("sources") is not None:
        return analysis
    assets = [asset for asset in STORE.values("assets") if asset.get("project_id") == project["id"]]
    return build_analysis(project, assets)


def sources_for_project(project: dict[str, Any], analysis: dict[str, Any]) -> list[dict[str, Any]]:
    project_sources = [item for item in analysis.get("sources", []) if isinstance(item, dict)] if isinstance(analysis.get("sources"), list) else []
    known_ids = {as_text(item.get("id")) for item in project_sources if as_text(item.get("id"))}
    return project_sources + [item for item in knowledge_base_sources(project) if as_text(item.get("id")) not in known_ids]


def qa_sources_for_project(project: dict[str, Any], analysis: dict[str, Any], question: str) -> list[dict[str, Any]]:
    """Keep Q&A egress bounded to the most relevant local evidence rows."""

    hits = build_search_results(project, analysis, question)
    selected = [item["evidence"] for item in hits if isinstance(item.get("evidence"), dict)]
    if not selected:
        selected = sources_for_project(project, analysis)
    return selected[:6]


def build_search_results(project: dict[str, Any], analysis: dict[str, Any], query: str) -> list[dict[str, Any]]:
    """Search only the project's saved evidence and analysis records.

    This deliberately stays local in the MVP: a search hit is never presented as
    a live official lookup unless a future retrieval connector supplies a source
    record with its own URL and verification status.
    """

    normalized_query = as_text(query).casefold()
    query_terms = split_keywords(normalized_query)
    candidates: list[dict[str, Any]] = []
    sources = sources_for_project(project, analysis)
    for source in sources:
        if not isinstance(source, dict):
            continue
        source_id = as_text(source.get("id"))
        if not source_id:
            continue
        haystack = " ".join(as_text(source.get(key)) for key in ("title", "publisher", "excerpt", "reason", "url")).casefold()
        matched_terms = [term for term in query_terms if term.casefold() in haystack]
        if normalized_query and not matched_terms and normalized_query not in haystack:
            continue
        candidates.append({
            "id": f"search-{source_id}",
            "title": as_text(source.get("title"), f"{project.get('name', '项目')} 来源片段"),
            "kind": as_text(source.get("source_type"), "project_material"),
            "region": as_text(project.get("region"), "待补充"),
            "match": "、".join(matched_terms) if matched_terms else "项目证据记录",
            "source": as_text(source.get("publisher"), "当前项目材料"),
            "evidence_id": source_id,
            "evidence": {**source, "id": source_id, "excerpt": as_text(source.get("excerpt"), "暂无原文摘录。")},
        })
    if not candidates and not normalized_query:
        return candidates
    return candidates[:30]


def build_mock_qa(project: dict[str, Any], analysis: dict[str, Any], question: str) -> dict[str, Any]:
    source_ids = [as_text(item.get("id")) for item in qa_sources_for_project(project, analysis, question) if as_text(item.get("id"))]
    question_text = as_text(question)
    author_related = any(term in question_text for term in ("作者", "授权", "版权", "凭证", "来源"))
    if author_related:
        answer = "当前案卷还不能确认作者、授权范围或完整来源链。现有证据只支持把它们列为待补材料。"
        next_steps = ["补充素材作者、创作时间和来源", "上传许可证、授权合同或授权声明", "再用官方来源核对公开发布范围"]
    else:
        answer = f"关于“{question_text}”，当前案卷可以提供初步线索，但不能单独证明正式权利或已完成官方核验。"
        next_steps = ["查看关联来源档案页", "确认命中的名称、地域和素材是否属于本项目", "对高风险条目留下人工复核结论"]
    return {"answer": answer, "next_steps": next_steps, "evidence_ids": source_ids[:5], "provider": "mock", "model_version": MODEL_VERSION, "knowledge_base_version": KB_VERSION, "generated_at": now_iso(), "disclaimer": DISCLAIMER}


def build_deepseek_qa(project: dict[str, Any], analysis: dict[str, Any], question: str, request_id_value: str) -> dict[str, Any]:
    source_rows = [{"id": as_text(item.get("id")), "title": sanitize_external_text(item.get("title")), "publisher": sanitize_external_text(item.get("publisher")), "excerpt": sanitize_external_text(item.get("excerpt"))} for item in qa_sources_for_project(project, analysis, question) if isinstance(item, dict)]
    schema = '{"answer":"string","next_steps":["string"],"evidence_ids":["string"]}'
    system_prompt = "你是农文旅知识产权档案助手。只根据给定的脱敏项目字段和来源档案回答问题，不得把线索说成法律结论。必须输出 JSON，不要输出 Markdown 或 reasoning_content。evidence_ids 只能使用给定来源 id。"
    payload = {"project": {"name": sanitize_external_text(project.get("name")), "region": sanitize_external_text(project.get("region")), "category": sanitize_external_text(project.get("category"))}, "question": sanitize_external_text(question), "sources": source_rows, "json_schema_example": schema}
    raw, usage = deepseek_json([{"role": "system", "content": system_prompt}, {"role": "user", "content": "请回答以下问题，必须输出 JSON。\n" + json.dumps(payload, ensure_ascii=False)}], project["id"], request_id_value, max_tokens=600, operation="qa")
    allowed_ids = {row["id"] for row in source_rows}
    evidence_ids = [as_text(item) for item in raw.get("evidence_ids", []) if as_text(item) in allowed_ids] if isinstance(raw.get("evidence_ids"), list) else []
    next_steps = [as_text(item) for item in raw.get("next_steps", []) if as_text(item)][:6] if isinstance(raw.get("next_steps"), list) else []
    fallback = build_mock_qa(project, analysis, question)
    return {"answer": as_text(raw.get("answer"), fallback["answer"]), "next_steps": next_steps or fallback["next_steps"], "evidence_ids": evidence_ids or fallback["evidence_ids"], "provider": "deepseek", "model_version": usage.get("model", DEEPSEEK_MODEL), "knowledge_base_version": KB_VERSION, "generated_at": now_iso(), "disclaimer": DISCLAIMER}


def build_report(project: dict[str, Any], analysis: dict[str, Any], report_id: str) -> dict[str, Any]:
    lines = [
        f"# {project['name']}｜知识产权风险初筛报告",
        "",
        f"- 生成时间：{analysis.get('generated_at', now_iso())}",
        f"- 模型版本：{analysis.get('model_version', MODEL_VERSION)}",
        f"- 知识库版本：{analysis.get('knowledge_base_version', KB_VERSION)}",
        f"- 项目地区：{project.get('region') or '未填写'}",
        f"- 项目类别：{project.get('category') or '未填写'}",
        "",
        "## 结论摘要",
        "",
        analysis.get("summary", "暂无摘要"),
        "",
        "## 权利线索",
        "",
    ]
    for candidate in analysis.get("right_candidates", []):
        lines.append(f"- **{candidate['right_type']}**：{candidate['reason']}（置信度 {candidate['confidence']:.2f}，需人工复核）")
    lines.extend(["", "## 风险与行动", ""])
    for finding in analysis.get("findings", []):
        lines.extend([
            f"- **{finding['level']}**：{finding['trigger']}",
            f"  - 建议：{finding['recommendation']}",
            f"  - 证据：{', '.join(finding.get('evidence_ids', [])) or '信息不足'}",
        ])
    lines.extend(["", "## 证据", ""])
    for source in analysis.get("sources", []):
        lines.extend([f"- `{source['id']}`：{source['excerpt']}", f"  - 来源：{source['publisher']}；访问时间：{source['retrieved_at']}"])
    lines.extend(["", "## 限制说明", "", analysis.get("disclaimer", DISCLAIMER), ""])
    content = "\n".join(lines)
    return {
        "id": report_id,
        "project_id": project["id"],
        "version": 1,
        "model_version": analysis.get("model_version", MODEL_VERSION),
        "knowledge_base_version": analysis.get("knowledge_base_version", KB_VERSION),
        "content": content,
        "analysis": analysis,
        "created_at": now_iso(),
        "disclaimer": DISCLAIMER,
    }


def update_analysis_item(project: dict[str, Any], collection: str, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Validate and persist one human review edit inside a project's analysis."""

    analysis = project.get("analysis")
    if not isinstance(analysis, dict):
        raise ApiError(409, "ANALYSIS_NOT_READY", "请先完成项目分析")
    items = analysis.get(collection)
    if not isinstance(items, list):
        raise ApiError(404, "NOT_FOUND", "分析结果不存在")
    item = next((candidate for candidate in items if candidate.get("id") == item_id), None)
    if item is None:
        raise ApiError(404, "NOT_FOUND", "分析项不存在", {"id": item_id})

    if "expected_version" in payload:
        expected = payload.get("expected_version")
        if not isinstance(expected, int) or expected < 1:
            raise ApiError(422, "VALIDATION_ERROR", "expected_version 必须是正整数")
        actual = int(item.get("version", 1))
        if expected != actual:
            raise ApiError(409, "VERSION_CONFLICT", "分析项已被其他修改更新", {"expected_version": expected, "actual_version": actual})

    if collection == "entities":
        allowed = {"value", "type", "confidence", "review_status", "source_chunk_id", "expected_version"}
        unknown = sorted(set(payload) - allowed)
        if unknown:
            raise ApiError(422, "VALIDATION_ERROR", "存在不可编辑的实体字段", {"fields": unknown})
        if "value" in payload:
            value = as_text(payload.get("value"))
            if not value:
                raise ApiError(422, "VALIDATION_ERROR", "实体值不能为空", {"field": "value"})
            item["value"] = value
        if "type" in payload:
            entity_type = as_text(payload.get("type"))
            if not entity_type:
                raise ApiError(422, "VALIDATION_ERROR", "实体类型不能为空", {"field": "type"})
            item["type"] = entity_type
        if "confidence" in payload:
            try:
                confidence = float(payload["confidence"])
            except (TypeError, ValueError) as exc:
                raise ApiError(422, "VALIDATION_ERROR", "confidence 必须是数字", {"field": "confidence"}) from exc
            if not 0 <= confidence <= 1:
                raise ApiError(422, "VALIDATION_ERROR", "confidence 必须在 0 到 1 之间", {"field": "confidence"})
            item["confidence"] = confidence
        if "review_status" in payload:
            review_status = as_text(payload.get("review_status"))
            if review_status not in {"unreviewed", "confirmed", "needs_review", "rejected", "待确认", "已确认", "待核验", "已驳回"}:
                raise ApiError(422, "VALIDATION_ERROR", "review_status 无效", {"field": "review_status"})
            item["review_status"] = review_status
        if "source_chunk_id" in payload:
            item["source_chunk_id"] = payload.get("source_chunk_id") or None
    else:
        allowed = {"level", "trigger", "recommendation", "status", "assignee", "review_required", "evidence_ids", "type", "title", "expected_version"}
        unknown = sorted(set(payload) - allowed)
        if unknown:
            raise ApiError(422, "VALIDATION_ERROR", "存在不可编辑的风险项字段", {"fields": unknown})
        if "level" in payload:
            level = as_text(payload.get("level"))
            if level not in {"high", "medium", "low", "insufficient"}:
                raise ApiError(422, "VALIDATION_ERROR", "风险等级无效", {"field": "level"})
            item["level"] = level
        for field in ("trigger", "recommendation", "assignee", "type", "title"):
            if field in payload:
                item[field] = as_text(payload.get(field))
        if "status" in payload:
            status = as_text(payload.get("status"))
            if status not in {"open", "confirmed", "rejected", "待处理", "已确认", "已驳回"}:
                raise ApiError(422, "VALIDATION_ERROR", "风险项状态无效", {"field": "status"})
            item["status"] = status
        if "review_required" in payload:
            if not isinstance(payload["review_required"], bool):
                raise ApiError(422, "VALIDATION_ERROR", "review_required 必须是布尔值", {"field": "review_required"})
            item["review_required"] = payload["review_required"]
        if "evidence_ids" in payload:
            evidence_ids = payload["evidence_ids"]
            if not isinstance(evidence_ids, list) or any(not isinstance(value, str) or not value for value in evidence_ids):
                raise ApiError(422, "VALIDATION_ERROR", "evidence_ids 必须是字符串数组", {"field": "evidence_ids"})
            item["evidence_ids"] = evidence_ids

    item["version"] = int(item.get("version", 0)) + 1
    item["updated_at"] = now_iso()
    analysis["last_reviewed_at"] = item["updated_at"]
    project["analysis"] = analysis
    project["updated_at"] = item["updated_at"]
    STORE.put("projects", project["id"], project)
    return item


def paginate(items: list[dict[str, Any]], query: dict[str, list[str]]) -> dict[str, Any]:
    try:
        page = max(1, int(query.get("page", ["1"])[0]))
        page_size = min(100, max(1, int(query.get("page_size", ["20"])[0])))
    except ValueError as exc:
        raise ApiError(400, "VALIDATION_ERROR", "page 和 page_size 必须是数字") from exc
    start = (page - 1) * page_size
    return {"items": items[start : start + page_size], "page": page, "page_size": page_size, "total": len(items)}


@dataclass
class MultipartFile:
    filename: str
    mime_type: str
    content: bytes


def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], MultipartFile | None]:
    """Parse the simple single-file upload shape used by the browser MVP.

    This avoids a third-party multipart dependency while still enforcing the
    documented size and MIME checks. It is intentionally not a general MIME
    parser; repeated fields and nested multipart are rejected.
    """

    match = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", content_type)
    if not match:
        raise ApiError(400, "INVALID_MULTIPART", "multipart 请求缺少 boundary")
    boundary = (match.group(1) or match.group(2)).encode("utf-8")
    fields: dict[str, str] = {}
    file_part: MultipartFile | None = None
    for raw_part in body.split(b"--" + boundary):
        part = raw_part.strip(b"\r\n-")
        if not part or b"\r\n\r\n" not in part:
            continue
        raw_headers, value = part.split(b"\r\n\r\n", 1)
        headers = raw_headers.decode("utf-8", errors="replace")
        disposition = re.search(r'name="([^"]+)"(?:;\s*filename="([^"]*)")?', headers, re.I)
        if not disposition:
            continue
        name, filename = disposition.group(1), disposition.group(2)
        if filename is None:
            fields[name] = value.decode("utf-8", errors="replace").strip()
            continue
        mime_match = re.search(r"Content-Type:\s*([^\r\n]+)", headers, re.I)
        mime_type = (mime_match.group(1).strip() if mime_match else "application/octet-stream")
        file_part = MultipartFile(filename=Path(filename).name, mime_type=mime_type, content=value.rstrip(b"\r\n"))
    return fields, file_part


class Handler(BaseHTTPRequestHandler):
    server_version = "ZhiHeXiangBanMVP/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep logs useful but avoid echoing request bodies or credentials.
        print(f"[{now_iso()}] {self.command} {self.path} - {fmt % args}")

    def _send(self, status: int, payload: Any, content_type: str = "application/json; charset=utf-8", headers: dict[str, str] | None = None) -> None:
        if isinstance(payload, bytes):
            body = payload
        elif isinstance(payload, str):
            body = payload.encode("utf-8")
        else:
            body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", os.getenv("CORS_ORIGIN", "*"))
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, exc: ApiError, req_id: str | None = None) -> None:
        self._send(exc.status, error_payload(exc, req_id or request_id()))

    def _body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ApiError(400, "INVALID_CONTENT_LENGTH", "Content-Length 无效") from exc
        max_bytes = int(os.getenv("MAX_REQUEST_BYTES", str(20 * 1024 * 1024 + 1024)))
        if length > max_bytes:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "请求体超过大小限制")
        return self.rfile.read(length)

    def _json_body(self) -> dict[str, Any]:
        return parse_json_bytes(self._body())

    def do_OPTIONS(self) -> None:
        self._send(204, b"")

    def do_GET(self) -> None:
        req_id = request_id()
        try:
            path, query = self._route()
            if path == f"{API_PREFIX}/health":
                provider = os.getenv("MODEL_PROVIDER", "mock").lower()
                self._send(200, {"status": "ok", "service": "zhihe-xiangban-api", "provider": provider, "knowledge_base_version": KB_VERSION, "request_id": req_id})
                return
            if path == f"{API_PREFIX}/projects":
                projects = sorted(STORE.values("projects"), key=lambda item: item.get("created_at", ""), reverse=True)
                status = query.get("status", [None])[0]
                if status:
                    projects = [project for project in projects if project.get("status") == status]
                self._send(200, paginate(projects, query))
                return
            if path == f"{API_PREFIX}/settings":
                self._send(200, {"provider": os.getenv("MODEL_PROVIDER", "mock"), "provider_configured": bool(os.getenv("DEEPSEEK_API_KEY")), "external_llm_allowed": os.getenv("EXTERNAL_LLM_ALLOWED", "false").lower() == "true", "knowledge_base_version": KB_VERSION, "request_id": req_id})
                return
            if path == f"{API_PREFIX}/usage/summary":
                project_id = query.get("project_id", [None])[0]
                self._send(200, {"provider": provider_name(), "project_id": project_id, "project_cost": usage_cost(project_id=project_id) if project_id else None, "daily_cost": usage_cost(period="day"), "monthly_cost": usage_cost(period="month"), "budgets": {"request": float(os.getenv("DEEPSEEK_REQUEST_BUDGET_CNY", "0.05")), "project": float(os.getenv("DEEPSEEK_PROJECT_BUDGET_CNY", "0.20")), "daily": float(os.getenv("DEEPSEEK_DAILY_BUDGET_CNY", "1.00")), "monthly": float(os.getenv("DEEPSEEK_MONTHLY_BUDGET_CNY", "20.00"))}, "request_id": req_id})
                return
            segments = [segment for segment in path.split("/") if segment]
            if len(segments) >= 4 and segments[:3] == ["api", "v1", "projects"]:
                project_id = segments[3]
                project = get_project(project_id)
                if len(segments) == 4:
                    self._send(200, project)
                    return
                if len(segments) == 5 and segments[4] == "assets":
                    assets = [asset for asset in STORE.values("assets") if asset.get("project_id") == project_id]
                    self._send(200, paginate(assets, query))
                    return
                if len(segments) == 5 and segments[4] == "findings":
                    analysis = project.get("analysis") or {}
                    self._send(200, paginate(analysis.get("findings", []), query))
                    return
                if len(segments) == 5 and segments[4] == "entities":
                    analysis = project.get("analysis") or {}
                    self._send(200, paginate(analysis.get("entities", []), query))
                    return
                if len(segments) == 5 and segments[4] == "reports":
                    reports = [report for report in STORE.values("reports") if report.get("project_id") == project_id]
                    self._send(200, paginate(reports, query))
                    return
                if len(segments) == 5 and segments[4] == "analysis":
                    self._send(200, project.get("analysis") or {"status": "not_started", "request_id": req_id})
                    return
            if len(segments) == 4 and segments[:3] == ["api", "v1", "tasks"]:
                task = STORE.get("tasks", segments[3])
                if not task:
                    raise ApiError(404, "NOT_FOUND", "任务不存在")
                self._send(200, task)
                return
            if len(segments) == 4 and segments[:3] == ["api", "v1", "assets"]:
                asset = STORE.get("assets", segments[3])
                if not asset:
                    raise ApiError(404, "NOT_FOUND", "材料不存在")
                self._send(200, asset)
                return
            if len(segments) == 4 and segments[:3] == ["api", "v1", "reports"]:
                report = STORE.get("reports", segments[3])
                if not report:
                    raise ApiError(404, "NOT_FOUND", "报告不存在")
                self._send(200, report)
                return
            if len(segments) == 5 and segments[:3] == ["api", "v1", "reports"] and segments[4] == "export":
                report = STORE.get("reports", segments[3])
                if not report:
                    raise ApiError(404, "NOT_FOUND", "报告不存在")
                fmt = query.get("format", ["md"])[0].lower()
                if fmt == "md":
                    body = report["content"].encode("utf-8")
                    self._send(200, body, "text/markdown; charset=utf-8", {"Content-Disposition": f"attachment; filename=report-{report['id']}.md"})
                    return
                if fmt == "json":
                    self._send(200, report, "application/json; charset=utf-8", {"Content-Disposition": f"attachment; filename=report-{report['id']}.json"})
                    return
                raise ApiError(415, "UNSUPPORTED_FORMAT", "仅支持 md 或 json")
            raise ApiError(404, "NOT_FOUND", "接口不存在")
        except ApiError as exc:
            self._error(exc, req_id)
        except Exception as exc:  # pragma: no cover - defensive HTTP boundary
            print(f"[{req_id}] internal error: {type(exc).__name__}: {exc}")
            self._error(ApiError(500, "INTERNAL_ERROR", "服务器内部错误"), req_id)

    def do_POST(self) -> None:
        req_id = request_id()
        try:
            path, _query = self._route()
            if path == f"{API_PREFIX}/projects":
                payload = self._json_body()
                name = as_text(payload.get("name"))
                if not name:
                    raise ApiError(422, "VALIDATION_ERROR", "项目名称不能为空", {"field": "name"})
                privacy = validate_privacy(payload.get("privacy_level"))
                consent = bool(payload.get("external_llm_consent", False))
                if privacy == "local_only":
                    consent = False
                project_id = new_id("project")
                project = {
                    "id": project_id,
                    "name": name,
                    "region": as_text(payload.get("region")),
                    "category": as_text(payload.get("category"), "农文旅"),
                    "description": as_text(payload.get("description")),
                    "status": "draft",
                    "privacy_level": privacy,
                    "external_llm_consent": consent,
                    "consent_at": now_iso() if consent else None,
                    "assets_count": 0,
                    "analysis": None,
                    "created_at": now_iso(),
                    "updated_at": now_iso(),
                }
                STORE.put("projects", project_id, project)
                self._send(201, {**project, "request_id": req_id})
                return
            segments = [segment for segment in path.split("/") if segment]
            if len(segments) == 5 and segments[:3] == ["api", "v1", "tasks"] and segments[4] == "retry":
                original_id = segments[3]
                original = STORE.get("tasks", original_id)
                if not original:
                    raise ApiError(404, "NOT_FOUND", "任务不存在")
                if original.get("status") != "failed":
                    raise ApiError(409, "TASK_NOT_RETRYABLE", "只有失败任务可以重试", {"status": original.get("status")})
                if original.get("type") != "asset_parse" or not original.get("asset_id"):
                    raise ApiError(409, "TASK_NOT_RETRYABLE", "当前 Mock 版本只支持重试材料解析任务")
                asset = STORE.get("assets", original["asset_id"])
                if not asset:
                    raise ApiError(404, "NOT_FOUND", "任务关联的材料不存在")
                new_task_id = new_id("task")
                asset.update({"parse_status": "queued", "parse_error": None, "progress": 0, "error_message": None, "task_id": new_task_id})
                retry_task = {
                    **original,
                    "task_id": new_task_id,
                    "status": "queued",
                    "progress": 0,
                    "stage": "queued",
                    "error_code": None,
                    "error_message": None,
                    "request_id": req_id,
                    "source_task_id": original_id,
                    "created_at": now_iso(),
                    "updated_at": now_iso(),
                }
                asset["parse_task_id"] = new_task_id
                STORE.put("assets", asset["id"], asset)
                STORE.put("tasks", new_task_id, retry_task)
                _schedule_asset_parse(new_task_id, asset["id"])
                self._send(202, {"task_id": new_task_id, "status": "queued", "request_id": req_id})
                return
            if len(segments) >= 4 and segments[:3] == ["api", "v1", "projects"]:
                project_id = segments[3]
                project = get_project(project_id)
                if len(segments) == 5 and segments[4] == "search":
                    payload = self._json_body()
                    query = as_text(payload.get("query"))
                    if not query:
                        raise ApiError(422, "VALIDATION_ERROR", "检索词不能为空", {"field": "query"})
                    if len(query) > 200:
                        raise ApiError(422, "VALIDATION_ERROR", "检索词不能超过 200 个字符", {"field": "query"})
                    analysis = analysis_for_project(project)
                    items = build_search_results(project, analysis, query)
                    self._send(200, {"items": items, "total": len(items), "provider": "mock-search", "knowledge_base_version": KB_VERSION, "request_id": req_id})
                    return
                if len(segments) == 5 and segments[4] in {"ask", "qa"}:
                    payload = self._json_body()
                    question = as_text(payload.get("question"))
                    if not question:
                        raise ApiError(422, "VALIDATION_ERROR", "问题不能为空", {"field": "question"})
                    if len(question) > 1000:
                        raise ApiError(422, "VALIDATION_ERROR", "问题不能超过 1000 个字符", {"field": "question"})
                    analysis = analysis_for_project(project)
                    if provider_name() == "deepseek":
                        require_external_consent(project)
                        answer = build_deepseek_qa(project, analysis, question, req_id)
                    else:
                        answer = build_mock_qa(project, analysis, question)
                    self._send(200, {**answer, "request_id": req_id})
                    return
                if len(segments) == 5 and segments[4] == "analysis":
                    payload = self._json_body()
                    right_types = payload.get("right_types", list(SUPPORTED_RIGHT_TYPES))
                    if not isinstance(right_types, list) or any(value not in SUPPORTED_RIGHT_TYPES for value in right_types):
                        raise ApiError(422, "VALIDATION_ERROR", "right_types 只能包含商标、版权和地理标志")
                    assets = [asset for asset in STORE.values("assets") if asset.get("project_id") == project_id]
                    if provider_name() == "deepseek":
                        require_external_consent(project)
                        analysis = build_deepseek_analysis(project, assets, req_id)
                    else:
                        analysis = build_analysis(project, assets)
                        analysis["provider"] = "mock"
                    analysis["right_candidates"] = [item for item in analysis["right_candidates"] if item["right_type"] in right_types]
                    project["analysis"] = analysis
                    project["status"] = "active"
                    project["updated_at"] = now_iso()
                    STORE.put("projects", project_id, project)
                    task_id = new_id("task")
                    task = {"task_id": task_id, "project_id": project_id, "type": "analysis", "status": "succeeded", "progress": 100, "stage": "completed", "error_code": None, "error_message": None, "request_id": req_id, "provider": analysis.get("provider", "mock"), "result": analysis, "created_at": now_iso(), "updated_at": now_iso()}
                    STORE.put("tasks", task_id, task)
                    self._send(202, {"task_id": task_id, "status": "succeeded", "model_version": MODEL_VERSION, "knowledge_base_version": KB_VERSION, "request_id": req_id})
                    return
                if len(segments) == 5 and segments[4] == "reports":
                    payload = self._json_body()
                    analysis = project.get("analysis") or build_analysis(project)
                    report_id = new_id("report")
                    report = build_report(project, analysis, report_id)
                    STORE.put("reports", report_id, report)
                    task_id = new_id("task")
                    task = {"task_id": task_id, "project_id": project_id, "type": "report", "status": "succeeded", "progress": 100, "stage": "completed", "error_code": None, "error_message": None, "request_id": req_id, "result": {"report_id": report_id}, "created_at": now_iso(), "updated_at": now_iso()}
                    STORE.put("tasks", task_id, task)
                    self._send(202, {"task_id": task_id, "status": "succeeded", "report_id": report_id, "format": payload.get("format", "markdown"), "request_id": req_id})
                    return
                if len(segments) == 5 and segments[4] == "assets":
                    asset = self._create_asset(project, req_id)
                    self._send(202, asset)
                    return
            raise ApiError(404, "NOT_FOUND", "接口不存在")
        except ApiError as exc:
            self._error(exc, req_id)
        except Exception as exc:  # pragma: no cover
            print(f"[{req_id}] internal error: {type(exc).__name__}: {exc}")
            self._error(ApiError(500, "INTERNAL_ERROR", "服务器内部错误"), req_id)

    def do_PATCH(self) -> None:
        req_id = request_id()
        try:
            path, _query = self._route()
            segments = [segment for segment in path.split("/") if segment]
            if len(segments) == 4 and segments[:3] == ["api", "v1", "projects"]:
                project = get_project(segments[3])
                payload = self._json_body()
                allowed = {"name", "region", "category", "description", "status"}
                unknown = sorted(set(payload) - allowed)
                if unknown:
                    raise ApiError(422, "VALIDATION_ERROR", "存在不可编辑字段", {"fields": unknown})
                if "name" in payload and not as_text(payload["name"]):
                    raise ApiError(422, "VALIDATION_ERROR", "项目名称不能为空", {"field": "name"})
                if "status" in payload and payload["status"] not in {"draft", "active", "archived"}:
                    raise ApiError(422, "VALIDATION_ERROR", "status 无效")
                project.update({key: as_text(value) for key, value in payload.items()})
                project["updated_at"] = now_iso()
                STORE.put("projects", project["id"], project)
                self._send(200, {**project, "request_id": req_id})
                return
            if len(segments) == 5 and segments[:3] == ["api", "v1", "projects"] and segments[4] == "privacy":
                project = get_project(segments[3])
                payload = self._json_body()
                privacy = validate_privacy(payload.get("privacy_level"))
                consent = bool(payload.get("external_llm_consent", False)) and privacy == "external_allowed"
                project.update({"privacy_level": privacy, "external_llm_consent": consent, "consent_at": now_iso() if consent else None, "updated_at": now_iso()})
                STORE.put("projects", project["id"], project)
                self._send(200, {"id": project["id"], "privacy_level": privacy, "external_llm_consent": consent, "consent_at": project["consent_at"], "request_id": req_id})
                return
            if len(segments) == 6 and segments[:3] == ["api", "v1", "projects"] and segments[4] in {"entities", "findings"}:
                project = get_project(segments[3])
                payload = self._json_body()
                collection = segments[4]
                item = update_analysis_item(project, collection, segments[5], payload)
                self._send(200, {**item, "request_id": req_id})
                return
            if len(segments) == 4 and segments[:3] in (["api", "v1", "entities"], ["api", "v1", "findings"]):
                collection = segments[2]
                payload = self._json_body()
                matching_projects = []
                for candidate in STORE.values("projects"):
                    candidate_analysis = candidate.get("analysis") or {}
                    if any(item.get("id") == segments[3] for item in candidate_analysis.get(collection, [])):
                        matching_projects.append(candidate["id"])
                if not matching_projects:
                    raise ApiError(404, "NOT_FOUND", "分析项不存在", {"id": segments[3]})
                item = update_analysis_item(get_project(matching_projects[0]), collection, segments[3], payload)
                self._send(200, {**item, "request_id": req_id})
                return
            raise ApiError(404, "NOT_FOUND", "接口不存在")
        except ApiError as exc:
            self._error(exc, req_id)
        except Exception as exc:  # pragma: no cover
            print(f"[{req_id}] internal error: {type(exc).__name__}: {exc}")
            self._error(ApiError(500, "INTERNAL_ERROR", "服务器内部错误"), req_id)

    def do_DELETE(self) -> None:
        req_id = request_id()
        try:
            path, query = self._route()
            segments = [segment for segment in path.split("/") if segment]
            if len(segments) == 4 and segments[:3] == ["api", "v1", "projects"]:
                project_id = segments[3]
                get_project(project_id)
                if query.get("confirm", ["false"])[0].lower() != "true":
                    raise ApiError(409, "CONFIRMATION_REQUIRED", "删除项目必须提供 confirm=true")
                for asset in STORE.values("assets"):
                    if asset.get("project_id") == project_id:
                        STORE.delete("assets", asset["id"])
                for task in STORE.values("tasks"):
                    if task.get("project_id") == project_id:
                        STORE.delete("tasks", task["task_id"])
                for report in STORE.values("reports"):
                    if report.get("project_id") == project_id:
                        STORE.delete("reports", report["id"])
                STORE.delete("projects", project_id)
                self._send(204, b"")
                return
            if len(segments) == 4 and segments[:3] == ["api", "v1", "assets"]:
                asset_id = segments[3]
                asset = STORE.get("assets", asset_id)
                if not asset:
                    raise ApiError(404, "NOT_FOUND", "材料不存在")
                if query.get("confirm", ["false"])[0].lower() != "true":
                    raise ApiError(409, "CONFIRMATION_REQUIRED", "删除材料必须提供 confirm=true")
                STORE.delete("assets", asset_id)
                project = get_project(asset["project_id"])
                project["assets_count"] = max(0, int(project.get("assets_count", 1)) - 1)
                project["updated_at"] = now_iso()
                STORE.put("projects", project["id"], project)
                self._send(204, b"")
                return
            raise ApiError(404, "NOT_FOUND", "接口不存在")
        except ApiError as exc:
            self._error(exc, req_id)
        except Exception as exc:  # pragma: no cover
            print(f"[{req_id}] internal error: {type(exc).__name__}: {exc}")
            self._error(ApiError(500, "INTERNAL_ERROR", "服务器内部错误"), req_id)

    def _create_asset(self, project: dict[str, Any], req_id: str) -> dict[str, Any]:
        current_count = len([asset for asset in STORE.values("assets") if asset.get("project_id") == project["id"]])
        if current_count >= int(os.getenv("MAX_ASSETS_PER_PROJECT", "10")):
            raise ApiError(413, "ASSET_LIMIT_EXCEEDED", "每个项目最多上传 10 个文件")
        content_type = self.headers.get("Content-Type", "")
        if content_type.lower().startswith("multipart/form-data"):
            fields, upload = parse_multipart(content_type, self._body())
            if upload is None:
                raise ApiError(400, "FILE_REQUIRED", "请上传文件")
            filename, mime_type, content = upload.filename, upload.mime_type.lower(), upload.content
            source_note = fields.get("source_note", "")
            authorization_status = fields.get("authorization_status", "pending")
        else:
            payload = parse_json_bytes(self._body())
            filename = Path(as_text(payload.get("filename"))).name
            mime_type = as_text(payload.get("mime_type"), "text/plain").lower()
            source_note = as_text(payload.get("source_note"))
            authorization_status = as_text(payload.get("authorization_status"), "pending")
            encoded = as_text(payload.get("content_base64"))
            try:
                content = base64.b64decode(encoded) if encoded else as_text(payload.get("text")).encode("utf-8")
            except (ValueError, base64.binascii.Error) as exc:
                raise ApiError(422, "VALIDATION_ERROR", "content_base64 无效") from exc
        max_file_size = int(os.getenv("MAX_FILE_SIZE_MB", "20")) * 1024 * 1024
        if not filename:
            raise ApiError(422, "VALIDATION_ERROR", "文件名不能为空")
        if mime_type not in SUPPORTED_ASSET_TYPES:
            raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "仅支持 PDF、DOCX、TXT、Markdown、PNG 和 JPG")
        if len(content) > max_file_size:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "单文件不能超过 20 MB")
        asset_id = new_id("asset")
        digest = hashlib.sha256(content).hexdigest()
        asset = {"id": asset_id, "project_id": project["id"], "filename": filename, "mime_type": mime_type, "size_bytes": len(content), "sha256": digest, "storage_key": f"{project['id']}/{asset_id}/original", "source_note": source_note, "authorization_status": authorization_status, "parse_status": "queued", "parse_error": None, "progress": 0, "error_message": None, "created_at": now_iso()}
        STORE.put("assets", asset_id, asset)
        project["assets_count"] = current_count + 1
        project["updated_at"] = now_iso()
        STORE.put("projects", project["id"], project)
        task_id = new_id("task")
        task = {"task_id": task_id, "project_id": project["id"], "asset_id": asset_id, "type": "asset_parse", "status": "queued", "progress": 0, "stage": "queued", "error_code": None, "error_message": None, "request_id": req_id, "created_at": now_iso(), "updated_at": now_iso()}
        asset["parse_task_id"] = task_id
        asset["task_id"] = task_id
        STORE.put("assets", asset_id, asset)
        STORE.put("tasks", task_id, task)
        _schedule_asset_parse(task_id, asset_id)
        return {"asset": asset, "task_id": task_id, "request_id": req_id}

    def _route(self) -> tuple[str, dict[str, list[str]]]:
        parsed = urlparse(self.path)
        return parsed.path.rstrip("/") or "/", parse_qs(parsed.query)


def create_server(host: str | None = None, port: int | None = None) -> ThreadingHTTPServer:
    bind_host = host or os.getenv("API_HOST", "127.0.0.1")
    bind_port = int(port or os.getenv("API_PORT", "8000"))
    return ThreadingHTTPServer((bind_host, bind_port), Handler)


def run() -> None:
    server = create_server()
    print(f"知禾乡伴 API listening on http://{server.server_address[0]}:{server.server_address[1]}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()

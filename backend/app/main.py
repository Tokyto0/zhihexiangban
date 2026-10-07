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
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse


API_PREFIX = "/api/v1"
DISCLAIMER = "本结果仅用于信息整理和风险初筛，不构成法律意见。"
KB_VERSION = os.getenv("KNOWLEDGE_BASE_VERSION", "seed-v1")
MODEL_VERSION = "mock-v1"
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
        self.data: dict[str, Any] = {"projects": {}, "tasks": {}, "reports": {}, "assets": {}}
        self._load()

    def _load(self) -> None:
        with self.lock:
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                self.data = {"projects": {}, "tasks": {}, "reports": {}, "assets": {}}
            for key in ("projects", "tasks", "reports", "assets"):
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
            "trigger": "名称或核心词的近似性尚未完成官方系统核验",
            "evidence_ids": [source["id"]],
            "recommendation": "拆分名称中的核心词、地域词和通用词，并通过官方查询入口做人工复核。",
            "status": "open",
            "review_required": True,
        },
        {
            "id": new_id("finding"),
            "level": "insufficient",
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
            if len(segments) >= 4 and segments[:3] == ["api", "v1", "projects"]:
                project_id = segments[3]
                project = get_project(project_id)
                if len(segments) == 5 and segments[4] == "analysis":
                    payload = self._json_body()
                    right_types = payload.get("right_types", list(SUPPORTED_RIGHT_TYPES))
                    if not isinstance(right_types, list) or any(value not in SUPPORTED_RIGHT_TYPES for value in right_types):
                        raise ApiError(422, "VALIDATION_ERROR", "right_types 只能包含商标、版权和地理标志")
                    assets = [asset for asset in STORE.values("assets") if asset.get("project_id") == project_id]
                    analysis = build_analysis(project, assets)
                    analysis["right_candidates"] = [item for item in analysis["right_candidates"] if item["right_type"] in right_types]
                    project["analysis"] = analysis
                    project["status"] = "active"
                    project["updated_at"] = now_iso()
                    STORE.put("projects", project_id, project)
                    task_id = new_id("task")
                    task = {"task_id": task_id, "project_id": project_id, "type": "analysis", "status": "succeeded", "progress": 100, "stage": "completed", "error_code": None, "error_message": None, "request_id": req_id, "result": analysis, "created_at": now_iso(), "updated_at": now_iso()}
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
        asset = {"id": asset_id, "project_id": project["id"], "filename": filename, "mime_type": mime_type, "size_bytes": len(content), "sha256": digest, "storage_key": f"{project['id']}/{asset_id}/original", "source_note": source_note, "authorization_status": authorization_status, "parse_status": "succeeded" if mime_type.startswith("text/") else "queued", "created_at": now_iso()}
        STORE.put("assets", asset_id, asset)
        project["assets_count"] = current_count + 1
        project["updated_at"] = now_iso()
        STORE.put("projects", project["id"], project)
        task_id = new_id("task")
        task = {"task_id": task_id, "project_id": project["id"], "type": "asset_parse", "status": "succeeded" if mime_type.startswith("text/") else "queued", "progress": 100 if mime_type.startswith("text/") else 0, "stage": "completed" if mime_type.startswith("text/") else "queued", "error_code": None, "error_message": None, "request_id": req_id, "created_at": now_iso(), "updated_at": now_iso()}
        STORE.put("tasks", task_id, task)
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

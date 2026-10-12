"""Offline HTTP contract checks for project search and evidence Q&A."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# Force the test process to use the deterministic provider before importing the
# backend module. The temporary store also prevents changes to the developer's
# local dossier.
os.environ["MODEL_PROVIDER"] = "mock"
temp_dir = tempfile.mkdtemp(prefix=".zhihe-api-contract-", dir=ROOT)
os.environ["MVP_STORE_PATH"] = os.path.join(temp_dir, "store.json")

from backend.app import main  # noqa: E402


class HandlerHarness:
    """Drive Handler.do_POST without opening a socket in restricted CI."""

    def __init__(self, path: str, payload: dict):
        self.path = path
        self.payload = payload
        self.result: tuple[int, dict] | None = None

    def _route(self):
        parsed = urlparse(self.path)
        return parsed.path.rstrip("/") or "/", parse_qs(parsed.query)

    def _json_body(self):
        return self.payload

    def _send(self, status, body, *_args, **_kwargs):
        self.result = (status, body)

    def _error(self, exc, req_id=None):
        self.result = (exc.status, main.error_payload(exc, req_id or "req-contract"))


def call(path: str, payload: dict) -> tuple[int, dict]:
    harness = HandlerHarness(path, payload)
    main.Handler.do_POST(harness)
    assert harness.result is not None
    return harness.result


try:
    status, project = call("/api/v1/projects", {"name": "契约测试项目", "region": "测试县", "category": "农文旅", "description": "仅用于接口回归"})
    assert status == 201
    project_id = project["id"]

    status, search = call(f"/api/v1/projects/{project_id}/search", {"query": "契约测试项目"})
    assert status == 200 and search["total"] >= 1
    hit = search["items"][0]
    assert hit["evidence_id"] and hit["evidence"]["id"] == hit["evidence_id"] and hit["evidence"]["excerpt"]

    status, answer = call(f"/api/v1/projects/{project_id}/ask", {"question": "当前项目还需要核查什么？"})
    required = {"answer", "next_steps", "evidence_ids", "provider", "model_version", "prompt_version", "knowledge_base_version", "generated_at", "disclaimer", "usage", "estimated_cost", "actual_cost", "currency", "pricing_version", "budget_status", "evidence_coverage"}
    assert status == 200 and required <= answer.keys() and answer["provider"] == "mock"
    assert answer["expertise_scope"] == "农文旅知识产权信息整理与风险初筛"
    assert answer["prompt_version"] == "evidence-answer-v1"
    assert answer["facts"] and answer["assessment"] and answer["uncertainties"] and answer["sources"]
    assert answer["usage"]["prompt_tokens"] == answer["usage"]["completion_tokens"] == answer["usage"]["total_tokens"] == 0
    assert answer["estimated_cost"] == answer["actual_cost"] == 0.0 and answer["currency"] == "CNY"
    assert answer["budget_status"]["state"] == "not_applicable" and answer["budget_status"]["allowed"] is True
    assert all(item["evidence_ids"] for item in answer["facts"] + answer["assessment"])
    assert answer["evidence_coverage"]["state"] == "pass"
    assert answer["evidence_coverage"]["facts_cited"] == answer["evidence_coverage"]["facts_total"]
    assert answer["evidence_coverage"]["assessment_cited"] == answer["evidence_coverage"]["assessment_total"]

    # Keep /qa as a backwards-compatible alias while the product contract uses /ask.
    status, alias = call(f"/api/v1/projects/{project_id}/qa", {"question": "来源是什么？"})
    assert status == 200 and alias["provider"] == "mock"

    invalid_cases = [
        (f"/api/v1/projects/{project_id}/search", {"query": ""}),
        (f"/api/v1/projects/{project_id}/search", {"query": "x" * 201}),
        (f"/api/v1/projects/{project_id}/ask", {"question": ""}),
        (f"/api/v1/projects/{project_id}/ask", {"question": "x" * 1001}),
    ]
    for path, payload in invalid_cases:
        status, error = call(path, payload)
        assert status == 422 and error["code"] == "VALIDATION_ERROR"

    print(json.dumps({"ok": True, "search_evidence_id": hit["evidence_id"], "qa_provider": answer["provider"], "validated_errors": len(invalid_cases)}, ensure_ascii=False))
finally:
    shutil.rmtree(temp_dir, ignore_errors=True)

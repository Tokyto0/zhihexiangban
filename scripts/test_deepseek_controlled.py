"""Run one explicitly approved, minimal DeepSeek evidence-Q&A smoke test.

This script refuses to call the provider unless ``--confirm-external`` is
present. It never prints the API key or model answer, and it uses a temporary
local JsonStore for the usage record.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description="执行一次受控 DeepSeek Q&A smoke test")
parser.add_argument("--confirm-external", action="store_true", help="明确允许发送脱敏测试字段到 DeepSeek")
parser.add_argument("--knowledge-path", type=Path, help="仅在已明确授权本地资料外发时提供；默认使用合成证据")
parser.add_argument("--registry-path", type=Path, help="与 --knowledge-path 配套的来源登记文件")
args = parser.parse_args()
if not args.confirm_external:
    raise SystemExit("为避免意外产生外部调用，请显式添加 --confirm-external")

# The key itself is loaded by the backend's local .env loader and is never
# printed. The test project is synthetic and marked as externally allowed.
os.environ["MODEL_PROVIDER"] = "deepseek"
os.environ["EXTERNAL_LLM_ALLOWED"] = "true"
os.environ["KNOWLEDGE_BASE_VERSION"] = "local-v2" if args.knowledge_path else "controlled-synthetic-v1"
store_path = ROOT / "data/processed/knowledge/.deepseek-controlled-store.json"
synthetic_kb_path = ROOT / "data/processed/knowledge/.deepseek-controlled-kb.jsonl"
if args.knowledge_path:
    os.environ["KNOWLEDGE_BASE_PATH"] = str(args.knowledge_path)
    if args.registry_path:
        os.environ["SOURCE_REGISTRY_PATH"] = str(args.registry_path)
else:
    # No local source is sent by default. This keeps the external smoke test
    # limited to the synthetic project/evidence fixture below.
    synthetic_kb_path.write_text("", encoding="utf-8")
    os.environ["KNOWLEDGE_BASE_PATH"] = str(synthetic_kb_path)
    os.environ["SOURCE_REGISTRY_PATH"] = str(synthetic_kb_path)
os.environ["MVP_STORE_PATH"] = str(store_path)
sys.path.insert(0, str(ROOT))

from backend.app import main  # noqa: E402

if not os.getenv("DEEPSEEK_API_KEY", "").strip():
    raise SystemExit("DeepSeek API Key 未配置，未发起外部调用")

project = {
    "id": "controlled-deepseek-test",
    "name": "脱敏知识库受控测试项目",
    "region": "中国",
    "category": "农文旅",
    "description": "仅用于验证结构化证据问答，不包含真实用户材料。",
    "privacy_level": "external_allowed",
    "external_llm_consent": True,
}
analysis = main.build_analysis(project, [])
analysis["sources"] = [{
    "id": "synthetic-evidence-001",
    "title": "合成来源片段",
    "publisher": "本地测试夹具",
    "excerpt": "这是仅用于接口验收的合成证据，不对应真实主体或公开文件。",
    "status": "pending",
    "source_type": "synthetic_fixture",
}]
try:
    answer = main.build_deepseek_qa(project, analysis, "地理标志候选还需要核查哪些证据？", "req-controlled-deepseek")
    usage = main.STORE.values("usage")
    print(json.dumps({
        "ok": True,
        "provider": answer.get("provider"),
        "model_version": answer.get("model_version"),
        "knowledge_base_version": answer.get("knowledge_base_version"),
        "evidence_count": len(answer.get("evidence_ids", [])),
        "usage_records": len(usage),
        "usage_statuses": sorted({str(item.get("status")) for item in usage}),
    }, ensure_ascii=False))
finally:
    try:
        store_path.unlink()
    except FileNotFoundError:
        pass
    try:
        store_path.with_suffix(store_path.suffix + ".tmp").unlink()
    except FileNotFoundError:
        pass
    try:
        synthetic_kb_path.unlink()
    except FileNotFoundError:
        pass
    shutil.rmtree(store_path.parent / "__pycache__", ignore_errors=True)

"""Deterministic offline checks for the MVP contract."""
from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.main import build_analysis, build_report  # noqa: E402

project = {
    "id": "test-project",
    "name": "青岚茶旅品牌保护",
    "region": "青岚县 · 南山村",
    "category": "农产品品牌",
    "description": "高山云雾茶与采茶体验路线。",
}
analysis = build_analysis(project, [{"filename": "brand.md"}])
assert len(analysis["entities"]) >= 5
assert {item["right_type"] for item in analysis["right_candidates"]} == {"trademark", "copyright", "geographical_indication"}
assert len(analysis["findings"]) >= 2
assert all(item["evidence_ids"] for item in analysis["findings"])
report = build_report(project, analysis, "report-test")
assert "不构成法律意见" in report["content"]
assert "## 权利线索" in report["content"]
print(json.dumps({"ok": True, "entities": len(analysis["entities"]), "rights": len(analysis["right_candidates"]), "findings": len(analysis["findings"])}, ensure_ascii=False))

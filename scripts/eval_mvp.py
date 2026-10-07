from pathlib import Path
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.app.main import build_analysis  # noqa: E402

rows = []
for case_dir in sorted((ROOT / "data" / "seeds" / "examples").iterdir()):
    if not case_dir.is_dir():
        continue
    text = (case_dir / "input.md").read_text(encoding="utf-8")
    result = build_analysis({"id": case_dir.name, "name": case_dir.name, "region": "示例地区", "category": "农文旅", "description": text})
    rows.append({"case": case_dir.name, "entities": len(result["entities"]), "rights": len(result["right_candidates"]), "findings": len(result["findings"]), "evidence_coverage": all(item["evidence_ids"] for item in result["findings"])})
out = ROOT / "data" / "eval_report.json"
out.write_text(json.dumps({"knowledge_base_version": "seed-v1", "results": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"results": rows}, ensure_ascii=False))

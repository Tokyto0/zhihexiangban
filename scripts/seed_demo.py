from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
seed_root = ROOT / "data" / "seeds" / "examples"
cases = []
for case_dir in sorted(seed_root.iterdir()):
    if not case_dir.is_dir():
        continue
    expected = json.loads((case_dir / "expected.json").read_text(encoding="utf-8"))
    cases.append({"case": case_dir.name, "input": str(case_dir / "input.md"), "expected": expected})
out = ROOT / "data" / "seed_manifest.json"
out.write_text(json.dumps({"version": "seed-v1", "cases": cases}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"seed-v1 ready: {len(cases)} cases -> {out}")

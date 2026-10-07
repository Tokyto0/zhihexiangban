from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for relative in ["data/mvp_store.json", "data/seed_manifest.json", "data/eval_report.json"]:
    path = ROOT / relative
    if path.exists():
        path.unlink()
        print(f"removed {relative}")
print("demo data cleaned")

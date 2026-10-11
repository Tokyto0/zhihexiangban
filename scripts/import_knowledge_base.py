"""Create a local, redacted JSONL knowledge-base snapshot.

The source DOCX/PDF files stay read-only and are never copied to the output.
The generated snapshot is intentionally ignored by Git because provenance and
reuse permissions for the local reference files still need human review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
REDACTIONS = (
    (re.compile(r"sk-[A-Za-z0-9_-]{12,}"), "[REDACTED_KEY]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[REDACTED_EMAIL]"),
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "[REDACTED_PHONE]"),
    (re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)"), "[REDACTED_ID]"),
    (re.compile(r"(身份证(?:号|号码)?\s*[:：]?\s*)[0-9Xx*]{6,}"), r"\1[REDACTED_ID]"),
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def redact(text: str) -> str:
    value = text.replace("\x00", " ").encode("utf-8", "replace").decode("utf-8")
    for pattern, replacement in REDACTIONS:
        value = pattern.sub(replacement, value)
    return re.sub(r"[ \t\r\f\v]+", " ", value).strip()


def extract_docx(path: Path) -> list[tuple[int | None, str]]:
    with zipfile.ZipFile(path) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    paragraphs: list[tuple[int | None, str]] = []
    for paragraph in root.findall(".//w:p", NS):
        text = "".join(node.text or "" for node in paragraph.findall(".//w:t", NS))
        text = redact(text)
        if text:
            paragraphs.append((None, text))
    return paragraphs


def extract_pdf(path: Path) -> list[tuple[int | None, str]]:
    try:
        from PyPDF2 import PdfReader
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise RuntimeError("PDF 导入需要 PyPDF2；请先安装后重试。") from exc
    reader = PdfReader(str(path))
    pages: list[tuple[int | None, str]] = []
    for index, page in enumerate(reader.pages, start=1):
        text = redact(page.extract_text() or "")
        if text:
            pages.append((index, text))
    return pages


def chunk_text(text: str, size: int = 800, overlap: int = 120) -> Iterable[str]:
    start = 0
    while start < len(text):
        chunk = text[start : start + size].strip()
        if chunk:
            yield chunk
        if start + size >= len(text):
            break
        start += size - overlap


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def import_documents(input_dir: Path, output: Path, registry_output: Path, version: str) -> dict:
    output.parent.mkdir(parents=True, exist_ok=True)
    registry_output.parent.mkdir(parents=True, exist_ok=True)
    records: list[dict] = []
    registry: list[dict] = []
    failures: list[dict] = []
    processed = 0
    for path in sorted(input_dir.iterdir()):
        if path.suffix.lower() not in {".docx", ".pdf"}:
            continue
        file_hash = sha256(path)
        source_id = f"local-doc-{file_hash[:12]}"
        title = path.stem
        try:
            pages = extract_docx(path) if path.suffix.lower() == ".docx" else extract_pdf(path)
            processed += 1
        except Exception as exc:
            failures.append({"source_id": source_id, "error_type": type(exc).__name__})
            continue
        registry.append({
            "source_id": source_id,
            "publisher": "本地参考资料（待核验）",
            "title": title,
            "url": "",
            "retrieved_at": now_iso(),
            "license_basis": "local_reference_pending",
            "content_hash": f"sha256:{file_hash}",
            "status": "pending",
            "open_method": "local_reference_only",
        })
        chunk_index = 0
        for page_no, page_text in pages:
            for chunk in chunk_text(page_text):
                chunk_index += 1
                records.append({
                    "source_id": source_id,
                    "right_type": "unknown",
                    "region": "中国",
                    "title": title,
                    "text": chunk,
                    "page_no": page_no,
                    "chunk_index": chunk_index,
                    "effective_date": None,
                    "open_method": "local_reference_only",
                    "status": "pending",
                    "knowledge_base_version": version,
                })
    output.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in records) + ("\n" if records else ""), encoding="utf-8")
    registry_output.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in registry) + ("\n" if registry else ""), encoding="utf-8")
    manifest = {
        "knowledge_base_version": version,
        "generated_at": now_iso(),
        "input_directory": str(input_dir),
        "documents_processed": processed,
        "chunks_written": len(records),
        "sources_written": len(registry),
        "failures": failures,
        "redaction_patterns": ["api_key", "email", "phone", "national_id"],
        "license_status": "pending_manual_review",
    }
    output.with_suffix(".manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="将本地 DOCX/PDF 资料整理为脱敏 JSONL 知识库")
    parser.add_argument("--input-dir", type=Path, default=ROOT / "知识库")
    parser.add_argument("--output", type=Path, default=ROOT / "data/processed/knowledge/knowledge-local-v2.jsonl")
    parser.add_argument("--registry-output", type=Path, default=ROOT / "data/processed/knowledge/sources-local-v2.jsonl")
    parser.add_argument("--version", default="local-v2")
    args = parser.parse_args()
    manifest = import_documents(args.input_dir, args.output, args.registry_output, args.version)
    print(json.dumps({key: manifest[key] for key in ("knowledge_base_version", "documents_processed", "chunks_written", "sources_written", "failures", "license_status")}, ensure_ascii=False))


if __name__ == "__main__":
    main()

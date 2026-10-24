import base64
import json
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts/check_native_markdown_pdf.py"
SPEC = spec_from_file_location("check_native_markdown_pdf", SCRIPT)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

DOCUMENT = "Document start\nconst native = 42;\nDocument tail"


def make_report() -> dict:
    results = []
    for fixture in ("multiline", "long-line", "nested"):
        for width in (1543, 390):
            evidence = {"fixture": fixture, "width": width, "engine": "chromium", "renderedText": DOCUMENT}
            results.append(
                {
                    "attachments": [
                        {"name": "native-constraints.json", "body": base64.b64encode(json.dumps(evidence).encode()).decode()},
                        {"name": "native.pdf", "contentType": "application/pdf", "body": base64.b64encode(b"PDF fixture").decode()},
                    ]
                }
            )
    return {"stats": {"expected": 12, "unexpected": 0, "skipped": 0, "flaky": 0}, "suites": results}


@pytest.mark.parametrize("missing", [False, True])
def test_checks_pdf_document_content(monkeypatch, missing: bool) -> None:
    text = "Document tail" if missing else DOCUMENT
    monkeypatch.setattr(MODULE, "PdfReader", lambda stream: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: text)]))
    results = MODULE.inspect_report(make_report())
    assert len(results) == 6
    assert all(result["status"] == ("fail" if missing else "pass") for result in results)
    assert all(result["missing_lines"] == (2 if missing else 0) for result in results)


@pytest.mark.parametrize("failure", [None, "missing", "duplicate", "unexpected", "skipped", "flaky"])
def test_cli_requires_complete_passing_evidence(tmp_path: Path, monkeypatch, failure: str | None) -> None:
    monkeypatch.setattr(MODULE, "PdfReader", lambda stream: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: DOCUMENT)]))
    report = make_report()
    if failure == "missing":
        report["suites"].pop()
    elif failure == "duplicate":
        report["suites"].append(report["suites"][0])
    elif failure is not None:
        report["stats"][failure] = 1
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report))
    monkeypatch.setattr("sys.argv", [str(SCRIPT), str(path)])
    assert MODULE.main() == (0 if failure is None else 1)


def test_cli_rejects_invalid_pdf(tmp_path: Path, monkeypatch, capsys) -> None:
    path = tmp_path / "report.json"
    path.write_text(json.dumps(make_report()))
    monkeypatch.setattr("sys.argv", [str(SCRIPT), str(path)])
    assert MODULE.main() == 1
    assert "Regenerate the Playwright JSON report" in capsys.readouterr().err


def test_requires_one_pdf_per_chromium_case() -> None:
    report = make_report()
    report["suites"][0]["attachments"].pop()
    with pytest.raises(ValueError, match="exactly one PDF"):
        MODULE.inspect_report(report)


def test_rejects_duplicate_contract_attachments() -> None:
    report = make_report()
    attachments = report["suites"][0]["attachments"]
    attachments.append(attachments[0])
    with pytest.raises(ValueError, match="exactly one contract"):
        MODULE.inspect_report(report)


def test_cli_rejects_missing_contract(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(MODULE, "PdfReader", lambda stream: SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda: DOCUMENT)]))
    report = make_report()
    report["suites"][0]["attachments"].pop(0)
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report))
    monkeypatch.setattr("sys.argv", [str(SCRIPT), str(path)])
    assert MODULE.main() == 1


@pytest.mark.parametrize("failure", [None, "duplicate-mode", "missing-image"])
def test_independent_print_matrix_requires_both_modes_and_images(tmp_path: Path, monkeypatch, failure: str | None) -> None:
    report = make_report()
    original = report["suites"]
    report["suites"] = []
    report["stats"]["expected"] = 24
    for mode in ("light", "dark"):
        for result in json.loads(json.dumps(original)):
            attachment = result["attachments"][0]
            evidence = json.loads(base64.b64decode(attachment["body"]))
            evidence.update(mode="light" if failure == "duplicate-mode" else mode, requiresImages=True)
            attachment.update(name="markdown-print.json", body=base64.b64encode(json.dumps(evidence).encode()).decode())
            report["suites"].append(result)
    monkeypatch.setattr(
        MODULE,
        "PdfReader",
        lambda stream: SimpleNamespace(
            pages=[SimpleNamespace(images=[] if failure == "missing-image" else [object()], extract_text=lambda: DOCUMENT)]
        ),
    )
    path = tmp_path / "printing.json"
    path.write_text(json.dumps(report))
    monkeypatch.setattr("sys.argv", [str(SCRIPT), str(path), "--printing"])
    assert MODULE.main() == (0 if failure is None else 1)

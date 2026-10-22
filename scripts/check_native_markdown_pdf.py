"""Check actual PDF attachments in a native Markdown Playwright JSON report."""

import argparse
import base64
import io
import json
import sys
from pathlib import Path

from pypdf import PdfReader


def attachment_bytes(attachment: dict) -> bytes:
    if "body" in attachment:
        return base64.b64decode(attachment["body"], validate=True)
    return Path(attachment["path"]).read_bytes()


def inspect_report(value: object) -> list[dict]:
    results = []
    if isinstance(value, list):
        for child in value:
            results.extend(inspect_report(child))
    elif isinstance(value, dict):
        attachments = value.get("attachments", [])
        evidence = [
            item
            for item in attachments
            if item.get("name") in ("native-constraints.json", "markdown-print.json")
        ]
        if evidence:
            if len(evidence) != 1:
                raise ValueError("Each native case must attach exactly one contract")
            contract = json.loads(attachment_bytes(evidence[0]))
            if contract["engine"] != "chromium":
                return results
            pdfs = [
                item
                for item in attachments
                if item.get("contentType") == "application/pdf"
            ]
            if len(pdfs) != 1:
                raise ValueError(
                    "Each Chromium native case must attach exactly one PDF"
                )
            reader = PdfReader(io.BytesIO(attachment_bytes(pdfs[0])))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            normalized = "".join(text.split())
            expected_lines = [
                line.strip()
                for line in contract["renderedText"].splitlines()
                if line.strip()
            ]
            missing = [
                line
                for line in expected_lines
                if "".join(line.split()) not in normalized
            ]
            image_count = (
                sum(len(page.images) for page in reader.pages)
                if contract.get("requiresImages")
                else 0
            )
            results.append(
                {
                    "fixture": contract["fixture"],
                    "width": contract["width"],
                    "mode": contract.get("mode"),
                    "pages": len(reader.pages),
                    "status": "fail"
                    if missing or (contract.get("requiresImages") and image_count == 0)
                    else "pass",
                    "images": image_count,
                    "missing_lines": len(missing),
                    "missing_examples": [line[:160] for line in missing[:5]],
                    "scope": "PDF text extraction, not visual clipping, physical printing or Firefox acceptance",
                }
            )
        else:
            for child in value.values():
                results.extend(inspect_report(child))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument(
        "--printing",
        action="store_true",
        help="Require the independent light/dark printing matrix",
    )
    arguments = parser.parse_args()
    try:
        report = json.loads(arguments.report.read_text())
        results = inspect_report(report)
        expected_cases = {
            (fixture, width)
            for fixture in ("multiline", "long-line", "nested")
            for width in (1543, 390)
        }
        actual_cases = {(result["fixture"], result["width"]) for result in results}
        if arguments.printing:
            expected_cases = {
                (fixture, width, mode)
                for fixture, width in expected_cases
                for mode in ("light", "dark")
            }
            actual_cases = {
                (result["fixture"], result["width"], result["mode"])
                for result in results
            }
        complete = actual_cases == expected_cases and len(results) == len(
            expected_cases
        )
        stats = report.get("stats", {})
        browser_checks_pass = stats.get("expected") == (
            24 if arguments.printing else 12
        ) and all(stats.get(key) == 0 for key in ("unexpected", "skipped", "flaky"))
        accepted = (
            complete
            and browser_checks_pass
            and all(result["status"] == "pass" for result in results)
        )
        print(
            json.dumps(
                {
                    "status": "pass" if accepted else "fail",
                    "complete_pdf_matrix": complete,
                    "browser_checks_pass": browser_checks_pass,
                    "results": results,
                },
                indent=2,
            )
        )
        return 0 if accepted else 1
    except Exception as error:
        print(
            f"Native Markdown PDF verification failed: {error}. Regenerate the Playwright JSON report and check its PDF attachments.",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())

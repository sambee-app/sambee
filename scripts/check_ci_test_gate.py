"""Require each selected CI component to complete successfully."""

import json
import os
from collections.abc import Mapping

COMPONENT_JOBS = {
    "backend": "backend",
    "frontend": "frontend",
    "companion": "companion",
    "website": "website-docs",
}


def gate_errors(needs: Mapping[str, dict], event_name: str) -> list[str]:
    """Return failures, including unexpected skips and malformed selection outputs."""
    changes = needs.get("changes", {})
    if changes.get("result") != "success":
        return [f"Change detection did not succeed: {changes.get('result')}"]
    outputs = changes.get("outputs", {})
    errors = []
    for component, job in COMPONENT_JOBS.items():
        selection = outputs.get(component)
        result = needs.get(job, {}).get("result")
        if selection not in {"true", "false"}:
            errors.append(
                f"Missing or invalid component selection: {component}={selection}"
            )
        elif event_name == "workflow_dispatch" or selection == "true":
            if result != "success":
                errors.append(f"Required {job} job did not succeed: {result}")
        elif result not in {"success", "skipped"}:
            errors.append(f"Unselected {job} job failed or was cancelled: {result}")
    return errors


def main() -> int:
    """Validate GitHub's needs context without interpreting it as shell code."""
    try:
        errors = gate_errors(
            json.loads(os.environ["NEEDS_JSON"]), os.environ["EVENT_NAME"]
        )
    except (KeyError, TypeError, AttributeError, json.JSONDecodeError) as error:
        print(f"Cannot validate CI results: {error}")
        return 1
    for error in errors:
        print(error)
    if not errors:
        print("All selected CI components succeeded.")
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())

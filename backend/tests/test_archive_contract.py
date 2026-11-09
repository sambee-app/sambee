"""V2-only route and capability contract checks."""

import json
import re
from pathlib import Path
from typing import Any

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker

from app.api.archive_operations import v2_router
from app.models.connection import Connection

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
ROUTE_BINDINGS_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "route-bindings.json"
SCHEMA_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "schema.json"
CUTOVER_REJECTIONS_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "cutover-rejections-v2.json"
COMPANION_ROUTER_PATH = WORKSPACE_ROOT / "companion" / "src-tauri" / "src" / "server" / "mod.rs"
HTTP_METHODS = frozenset({"GET", "POST", "PUT", "DELETE"})
BACKEND_PREFIX = "/api/archive"


def _validate_contract_instance(schema_name: str, instance: object) -> None:
    schema: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(
        {"$ref": f"#/$defs/{schema_name}", "$defs": schema["$defs"]},
        format_checker=FormatChecker(),
    )
    errors = sorted(validator.iter_errors(instance), key=lambda error: list(error.absolute_path))
    assert not errors, "\n".join(error.message for error in errors)


def _documented_routes(owner: str) -> set[tuple[str, str]]:
    fixture: dict[str, Any] = json.loads(ROUTE_BINDINGS_PATH.read_text(encoding="utf-8"))
    assert fixture["version"] == "v2"
    assert fixture["unknown_fields"] == "rejected"
    routes = fixture["routes"]
    assert isinstance(routes, list) and routes
    assert all(
        isinstance(route, dict)
        and route.get("owner") in {"backend", "companion"}
        and route.get("method") in HTTP_METHODS
        and isinstance(route.get("path"), str)
        and route["path"].startswith("/api/")
        and isinstance(route.get("operation"), str)
        and isinstance(route.get("durable"), bool)
        and isinstance(route.get("capability"), bool)
        and route.get("idempotency") in {"none", "revision", "delivery-id"}
        and (route.get("request_schema") is None or isinstance(route.get("request_schema"), str))
        and isinstance(route.get("response_schema"), str)
        for route in routes
    )
    return {(route["method"], route["path"]) for route in routes if route["owner"] == owner}


def _registered_backend_routes() -> set[tuple[str, str]]:
    return {
        (method, f"{BACKEND_PREFIX}{route.path}")
        for route in v2_router.routes
        if isinstance(route, APIRoute)
        for method in route.methods or set()
        if method in HTTP_METHODS
    }


def _registered_companion_routes() -> set[tuple[str, str]]:
    source = COMPANION_ROUTER_PATH.read_text(encoding="utf-8")
    pattern = re.compile(
        r'\.route\(\s*"(?P<path>/api/(?:browse|viewer)/\{drive\}/archive/v2[^\"]*)",\s*'
        r"axum::routing::(?P<method>get|post|put|delete)\(handlers::\w+\)\s*,?\s*\)",
        flags=re.DOTALL,
    )
    return {(match.group("method").upper(), match.group("path")) for match in pattern.finditer(source)}


def test_v2_route_bindings_cover_every_registered_archive_route() -> None:
    assert _documented_routes("backend") == _registered_backend_routes()
    assert _documented_routes("companion") == _registered_companion_routes()


def test_v2_route_bindings_reference_defined_schemas() -> None:
    fixture: dict[str, Any] = json.loads(ROUTE_BINDINGS_PATH.read_text(encoding="utf-8"))
    schema: dict[str, Any] = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    definitions = schema.get("$defs")

    assert isinstance(definitions, dict)
    assert fixture["capability_schema"] in definitions
    for route in fixture["routes"]:
        for schema_name in (route["request_schema"], route["response_schema"]):
            if schema_name is not None:
                assert schema_name in definitions, f"{route['method']} {route['path']} references undefined schema {schema_name}"


def test_v2_runtime_backend_payloads_conform_to_the_shared_schema(
    client: TestClient,
    auth_headers_user: dict[str, str],
    test_connection: Connection,
) -> None:
    response = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "backup.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "backup",
            "selected_member_paths": ["docs", "readme.txt"],
        },
    )
    assert response.status_code == 201
    _validate_contract_instance("operationRead", response.json())

    invalid_response = client.get(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        params={"unexpected": "true"},
    )
    assert invalid_response.status_code == 422
    _validate_contract_instance("error", invalid_response.json())


def test_v2_direct_local_execution_specimen_conforms_to_the_shared_schema() -> None:
    collision = {
        "kind": "collision",
        "source_session_id": "source-session",
        "delivery_sequence": 1,
        "decision_revision": 1,
        "member_path": "notes.txt",
        "is_directory": False,
        "allowed_actions": ["skip", "replace", "rename"],
        "source": {"path": "notes.txt", "size": 42, "modified_at": "2025-01-01T00:00:00Z"},
        "target": {"path": "output/notes.txt", "size": None, "modified_at": None},
    }
    execution = {
        "contract_version": "v2",
        "execution_id": "2de1fe1d-8f71-4fd0-9774-250001597a78",
        "kind": "extract",
        "phase": "awaiting_user_decision",
        "revision": 3,
        "progress": {
            "completedMembers": 1,
            "skippedMembers": 0,
            "failedMembers": 0,
            "partialMembers": 0,
        },
        "cancellation_requested": False,
        "pendingDecision": collision,
    }
    _validate_contract_instance("directLocalExecution", execution)

    _validate_contract_instance(
        "directLocalStart",
        {
            "contract_version": "v2",
            "kind": "extract",
            "archive_path": "photos.zip",
            "destination_path": "output",
            "selected_member_paths": ["photos/one.jpg"],
            "member_base_path": "photos",
            "destination_drive": "d",
        },
    )

    for invalid_collision in (
        {key: value for key, value in collision.items() if key != "source"},
        {**collision, "source": {"path": "notes.txt", "size": 42}},
        {**collision, "target_path": "output/notes.txt"},
        {**collision, "target": {"path": "/output/notes.txt", "size": None, "modified_at": None}},
        {**collision, "allowed_actions": ["retry"]},
    ):
        with pytest.raises(AssertionError):
            _validate_contract_instance("directLocalExecution", {**execution, "pendingDecision": invalid_collision})


def test_live_extraction_status_requires_the_exact_aggregate_counter_set() -> None:
    valid_status = {
        "source_session_id": "source-session",
        "phase": "ready",
        "aggregate_counters": {
            "members_processed": 3,
            "members_completed": 1,
            "members_skipped": 1,
            "members_failed": 1,
            "files_extracted": 1,
            "directories_created": 0,
            "extracted_bytes": 42,
            "files_replaced": 0,
        },
    }
    _validate_contract_instance("liveExtractionStatus", valid_status)

    invalid_statuses = [
        {**valid_status, "aggregate_counters": {**valid_status["aggregate_counters"], "unexpected": 1}},
        {
            **valid_status,
            "aggregate_counters": {key: value for key, value in valid_status["aggregate_counters"].items() if key != "files_replaced"},
        },
        {**valid_status, "aggregate_counters": {**valid_status["aggregate_counters"], "members_processed": -1}},
        {**valid_status, "aggregate_counters": {**valid_status["aggregate_counters"], "members_processed": True}},
        {**valid_status, "aggregate_counters": {**valid_status["aggregate_counters"], "members_processed": 1.5}},
        {**valid_status, "phase": "unexpected"},
        {
            **valid_status,
            "aggregate_counters": {**valid_status["aggregate_counters"], "members_processed": 1 << 63},
        },
    ]
    for invalid_status in invalid_statuses:
        with pytest.raises(AssertionError):
            _validate_contract_instance("liveExtractionStatus", invalid_status)


def test_live_extraction_summary_rejects_invalid_counter_values() -> None:
    valid_summary = {
        "source_session_id": "source-session",
        "members_processed": 3,
        "members_completed": 1,
        "members_skipped": 1,
        "members_failed": 1,
        "files_extracted": 1,
        "directories_created": 0,
        "extracted_bytes": 42,
        "files_replaced": 0,
    }
    _validate_contract_instance("liveExtractionSummary", valid_summary)

    for value in (True, 1.5, 1 << 63):
        with pytest.raises(AssertionError):
            _validate_contract_instance(
                "liveExtractionSummary",
                {**valid_summary, "members_processed": value},
            )


def test_extraction_result_requires_the_s1_aggregate_shape() -> None:
    valid_result = {
        "members_processed": 3,
        "members_completed": 1,
        "members_skipped": 1,
        "members_failed": 1,
        "files_extracted": 1,
        "directories_created": 2,
        "extracted_bytes": 42,
        "files_replaced": 0,
        "phase": "awaiting_user_decision",
    }
    _validate_contract_instance("extractionResult", valid_result)

    for invalid_result in (
        {key: value for key, value in valid_result.items() if key != "members_failed"},
        {**valid_result, "files_skipped": 1},
        {**valid_result, "phase": "completed"},
        {**valid_result, "members_processed": 1 << 63},
    ):
        with pytest.raises(AssertionError):
            _validate_contract_instance("extractionResult", invalid_result)


def test_v2_inspection_query_schemas_are_owner_specific() -> None:
    _validate_contract_instance(
        "backendInspectionMemberQuery",
        {
            "contract_version": "v2",
            "connection_id": "connection-1",
            "archive_path": "backup.zip",
            "member_path": "docs/readme.pdf",
            "view_kind": "pdf",
            "viewport_width": 1024,
            "viewport_height": 768,
            "no_resizing": False,
            "screen_width": 1440,
            "screen_height": 900,
            "screen_zoom_percent": 200,
        },
    )
    _validate_contract_instance(
        "localInspectionMemberQuery",
        {
            "contract_version": "v2",
            "archive_path": "backup.zip",
            "member_path": "docs/readme.pdf",
            "download": False,
        },
    )


def test_v2_relay_routes_are_normalized_and_capability_bound() -> None:
    fixture: dict[str, Any] = json.loads(ROUTE_BINDINGS_PATH.read_text(encoding="utf-8"))
    relay_routes = [route for route in fixture["routes"] if "/relay/" in route["path"]]

    assert relay_routes
    assert all(
        route["path"].split("/relay/", maxsplit=1)[1].split("/", maxsplit=1)[0] in {"creation", "extraction"} for route in relay_routes
    )
    assert all(route["durable"] is True for route in relay_routes)
    assert all(route["capability"] is True for route in relay_routes if route["owner"] == "backend")
    assert all(
        route["capability"] is False for route in relay_routes if route["owner"] == "companion" and "/relay/extraction" in route["path"]
    )
    assert all("companion-relay" not in route["path"] for route in fixture["routes"])
    assert all("_to_" not in route["path"] and "_from_" not in route["path"] for route in relay_routes)


def test_retired_archive_routes_are_not_registered() -> None:
    backend_paths = {path for _method, path in _registered_backend_routes()}
    companion_paths = {path for _method, path in _registered_companion_routes()}
    fixture: dict[str, Any] = json.loads(CUTOVER_REJECTIONS_PATH.read_text(encoding="utf-8"))

    assert fixture["version"] == 2
    assert all(fragment not in path for fragment in fixture["retired_route_fragments"] for path in backend_paths | companion_paths)


def test_retired_backend_routes_return_not_found(client: TestClient) -> None:
    fixture: dict[str, Any] = json.loads(CUTOVER_REJECTIONS_PATH.read_text(encoding="utf-8"))

    for request in fixture["retired_backend_requests"]:
        response = client.request(request["method"], request["path"])
        assert response.status_code == request["status"]

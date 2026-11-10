"""Actual-coordinator archive conformance checks using deterministic test adapters."""

import asyncio
import json
import uuid
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from app.models.archive_operation import ArchiveOperation, ArchiveOperationKind, ArchiveOperationPhase
from app.services.archive.coordinator import (
    ArchiveCreationCoordinator,
    ArchiveCreationExecutionPlan,
    ArchiveCreationManifest,
    ArchiveCreationManifestMember,
    InMemoryArchiveExecutionStateStore,
    creation_outcome_summary,
)
from app.services.archive.creation import ArchiveCreationCancelled, ArchiveCreationMemberOutcome, ArchiveCreationResult
from app.services.archive.execution import (
    ArchiveExecutionDriver,
    ArchiveInspectionBinding,
    ArchiveInspectionOperationKind,
    resolve_archive_inspection_topology_plan,
    resolve_archive_operation_topology_plan,
)


class AdapterFault(StrEnum):
    MALFORMED_INPUT = "malformed_input"
    COLLISION = "collision"
    PARTIAL_WRITE = "partial_write"
    CANCELLATION = "cancellation"
    SOURCE_CHANGED = "source_changed"
    TRANSPORT_FAILURE = "transport_failure"


@dataclass(frozen=True)
class TopologyCase:
    name: str
    source_connection_id: str
    destination_connection_id: str
    driver: ArchiveExecutionDriver


@dataclass(frozen=True)
class FixtureCase:
    name: str
    operation: str
    topology: TopologyCase
    fault: AdapterFault | None
    expected_trace: dict[str, Any]


@dataclass(frozen=True)
class TrajectoryCase:
    operation: str
    topology: TopologyCase
    scenario_name: str
    expected_trace: dict[str, Any] | None


TOPOLOGY_CASES = (
    TopologyCase("smb_to_smb", "connection-1", "connection-1", ArchiveExecutionDriver.BACKEND),
    TopologyCase("local_to_local", "local-drive:c", "local-drive:c", ArchiveExecutionDriver.COMPANION),
    TopologyCase("smb_to_local", "connection-1", "local-drive:c", ArchiveExecutionDriver.COMPANION),
    TopologyCase("local_to_smb", "local-drive:c", "connection-1", ArchiveExecutionDriver.COMPANION),
)
BACKEND_TOPOLOGY_CASES = tuple(case for case in TOPOLOGY_CASES if case.driver == ArchiveExecutionDriver.BACKEND)
WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
EXTRACTION_TRAJECTORY_CORPUS_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "extraction-trajectory-scenarios-v2.json"
CREATION_TRAJECTORY_CORPUS_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "creation-trajectory-scenarios-v2.json"
TOPOLOGY_TRACE_FIXTURE_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "topology-execution-traces-v2.json"
TRAJECTORY_TRACE_FIXTURE_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "topology-trajectory-traces-v2.json"
TARGET_WRITE_CORPUS_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "target-write-resolution-scenarios-v2.json"


def _load_trajectory_scenarios(path: Path) -> tuple[dict[str, Any], ...]:
    corpus: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    assert corpus["version"] == 2
    assert {case.name for case in TOPOLOGY_CASES} == set(corpus["topologies"])
    return tuple(corpus["scenarios"])


EXTRACTION_TRAJECTORIES = _load_trajectory_scenarios(EXTRACTION_TRAJECTORY_CORPUS_PATH)
CREATION_TRAJECTORIES = _load_trajectory_scenarios(CREATION_TRAJECTORY_CORPUS_PATH)


class TraceRecordingStateStore(InMemoryArchiveExecutionStateStore):
    """Record coordinator-owned lifecycle transitions without changing test execution."""

    def __init__(self) -> None:
        super().__init__()
        self.phase_transitions = [ArchiveOperationPhase.PREPARED.value]
        self.pending_decision: str | None = None

    def transition(self, operation, *, expected_phase, next_phase, additional_changes=None):
        result = super().transition(
            operation,
            expected_phase=expected_phase,
            next_phase=next_phase,
            additional_changes=additional_changes,
        )
        self.phase_transitions.append(next_phase.value)
        return result

    def await_decision(self, operation, decision):
        result = super().await_decision(operation, decision)
        self.phase_transitions.append(ArchiveOperationPhase.AWAITING_USER_DECISION.value)
        self.pending_decision = "member_error" if decision.get("kind") == "member_error" else "collision"
        return result

    def fail(self, operation, message, *, error_code=None):
        result = super().fail(operation, message, error_code=error_code)
        self.phase_transitions.append(ArchiveOperationPhase.FAILED.value)
        return result

    def apply_extraction_decision(self, operation, action, member_path, target_path):
        result = super().apply_extraction_decision(operation, action, member_path, target_path)
        self.phase_transitions.append(ArchiveOperationPhase.STREAMING.value)
        return result


def _expected_trace(case_name: str) -> dict[str, Any]:
    fixture: dict[str, Any] = json.loads(TOPOLOGY_TRACE_FIXTURE_PATH.read_text(encoding="utf-8"))
    for case in fixture["cases"]:
        if case["name"] == case_name:
            return case["expected_trace"]
    raise AssertionError(f"Topology trace fixture does not define {case_name}")


def _fixture_cases() -> tuple[FixtureCase, ...]:
    fixture: dict[str, Any] = json.loads(TOPOLOGY_TRACE_FIXTURE_PATH.read_text(encoding="utf-8"))
    topologies = {case.name: case for case in TOPOLOGY_CASES}
    cases = []
    for raw_case in fixture["cases"]:
        fault = raw_case["fault"]
        cases.append(
            FixtureCase(
                name=raw_case["name"],
                operation=raw_case["operation"],
                topology=topologies[raw_case["topology"]],
                fault=AdapterFault(fault) if fault is not None else None,
                expected_trace=raw_case["expected_trace"],
            )
        )
    return tuple(cases)


def _trajectory_cases() -> tuple[TrajectoryCase, ...]:
    fixture: dict[str, Any] = json.loads(TOPOLOGY_TRACE_FIXTURE_PATH.read_text(encoding="utf-8"))
    trace_fixture: dict[str, Any] = json.loads(TRAJECTORY_TRACE_FIXTURE_PATH.read_text(encoding="utf-8"))
    assert trace_fixture["version"] == 2
    assert set(trace_fixture["trace_fields"]) == set(fixture["trace_fields"])
    expected_traces = {(case["operation"], case["topology"], case["scenario"]): case["expected_trace"] for case in trace_fixture["cases"]}
    topologies = {case.name: case for case in TOPOLOGY_CASES}
    trajectory_cases = tuple(
        TrajectoryCase(
            operation=raw_case["operation"],
            topology=topologies[raw_case["topology"]],
            scenario_name=raw_case["scenario"],
            expected_trace=expected_traces.get(
                (raw_case["operation"], raw_case["topology"], raw_case["scenario"]), raw_case.get("expected_trace")
            ),
        )
        for raw_case in fixture["trajectory_cases"]
    )
    assert {
        (case.operation, case.topology.name, case.scenario_name)
        for case in trajectory_cases
        if case.topology.driver == ArchiveExecutionDriver.BACKEND
    } == {(case["operation"], case["topology"], case["scenario"]) for case in trace_fixture["cases"] if case["topology"] == "smb_to_smb"}
    return trajectory_cases


BACKEND_FIXTURE_CASES = tuple(
    case for case in _fixture_cases() if case.topology.driver == ArchiveExecutionDriver.BACKEND and case.operation == "create"
)
BACKEND_TRAJECTORY_CASES = tuple(case for case in _trajectory_cases() if case.topology.driver == ArchiveExecutionDriver.BACKEND)


def test_topology_trace_fixture_matches_resolved_execution_owners() -> None:
    fixture: dict[str, Any] = json.loads(TOPOLOGY_TRACE_FIXTURE_PATH.read_text(encoding="utf-8"))
    target_write_corpus: dict[str, Any] = json.loads(TARGET_WRITE_CORPUS_PATH.read_text(encoding="utf-8"))

    assert fixture["version"] == 2
    assert set(fixture["adapter_faults"]) == {
        "malformed_input",
        "collision",
        "partial_write",
        "cancellation",
        "source_changed",
        "transport_failure",
    }
    assert set(fixture["trace_fields"]) == {
        "owner",
        "manifest_snapshot",
        "phase_transitions",
        "pending_decision",
        "member_outcomes",
        "terminal_summary",
        "error_category",
    }
    assert fixture["trajectory_trace_fixture"] == TRAJECTORY_TRACE_FIXTURE_PATH.name
    assert {case["name"] for case in fixture["topologies"]} == {case.name for case in TOPOLOGY_CASES}
    attempt_scenarios = {scenario["name"]: scenario for scenario in target_write_corpus["attempt_scenarios"]}
    assert {case["topology"] for case in fixture["target_write_attempt_cases"]} == {case.name for case in TOPOLOGY_CASES}
    for case in fixture["target_write_attempt_cases"]:
        scenario = attempt_scenarios[case["scenario"]]
        assert case["expected_disposition"] == scenario["expected"]
    success_cases = {(case["operation"], case["topology"]) for case in fixture["cases"] if case["fault"] is None}
    assert success_cases == {(operation, case.name) for operation in fixture["operations"] for case in TOPOLOGY_CASES}
    assert {case["fault"] for case in fixture["cases"] if case["fault"] is not None} == set(fixture["adapter_faults"])
    for operation in fixture["operations"]:
        for topology in fixture["topologies"]:
            topology_name = topology["name"]
            assert {
                case["fault"]
                for case in fixture["cases"]
                if case["operation"] == operation and case["topology"] == topology_name and case["fault"] is not None
            } == set(fixture["adapter_faults"]), f"{operation}/{topology_name} must declare every adapter fault"
    assert {case.fault for case in BACKEND_FIXTURE_CASES if case.fault is not None} == set(AdapterFault)
    assert {case.fault for case in BACKEND_FIXTURE_CASES if case.operation == "create" and case.fault is not None} == set(AdapterFault)
    corpus_scenarios = {
        "create": {scenario["name"] for scenario in CREATION_TRAJECTORIES},
        "extract": {scenario["name"] for scenario in EXTRACTION_TRAJECTORIES},
    }
    for operation, scenarios in corpus_scenarios.items():
        for topology in TOPOLOGY_CASES:
            represented = {
                case["scenario"]
                for case in fixture["trajectory_cases"]
                if case["operation"] == operation and case["topology"] == topology.name
            }
            assert represented == scenarios
    topology_owners = {case["name"]: case["owner"] for case in fixture["topologies"]}
    for trace_case in fixture["cases"]:
        trace = trace_case["expected_trace"]
        assert set(trace) == set(fixture["trace_fields"])
        assert trace["owner"] == topology_owners[trace_case["topology"]]
    for case in fixture["topologies"]:
        resolved = resolve_archive_operation_topology_plan(
            kind=ArchiveOperationKind.EXTRACT,
            source_connection_id=case["source_connection_id"],
            destination_connection_id=case["destination_connection_id"],
        )
        assert resolved.topology.driver.value == case["owner"]


@pytest.mark.parametrize("case", TOPOLOGY_CASES, ids=lambda case: case.name)
def test_cross_topology_inspection_plan_selects_the_source_executor(case: TopologyCase) -> None:
    plan = resolve_archive_inspection_topology_plan(source_connection_id=case.source_connection_id)

    assert plan.kind == ArchiveInspectionOperationKind.INSPECT
    assert plan.source_is_local is case.source_connection_id.startswith("local-drive:")
    assert plan.driver == (ArchiveExecutionDriver.COMPANION if plan.source_is_local else ArchiveExecutionDriver.BACKEND)
    assert plan.binding == (ArchiveInspectionBinding.COMPANION_LOCAL if plan.source_is_local else ArchiveInspectionBinding.BACKEND_SMB)


@pytest.mark.parametrize(
    ("source_connection_id", "destination_connection_id", "driver"),
    [
        ("local-drive:c", "local-drive:d", ArchiveExecutionDriver.COMPANION),
        ("connection-1", "connection-2", ArchiveExecutionDriver.BACKEND),
    ],
)
def test_distinct_provider_connections_select_archive_extraction_owners(
    source_connection_id: str,
    destination_connection_id: str,
    driver: ArchiveExecutionDriver,
) -> None:
    plan = resolve_archive_operation_topology_plan(
        kind=ArchiveOperationKind.EXTRACT,
        source_connection_id=source_connection_id,
        destination_connection_id=destination_connection_id,
    )

    assert plan.topology.driver == driver


@dataclass(frozen=True)
class DeterministicCreationAdapter:
    """Test-only creation adapter that commits only manifest-backed observations."""

    fault: AdapterFault | None = None

    async def run(self, on_member_completed, is_cancelled) -> ArchiveCreationResult:
        if self.fault == AdapterFault.CANCELLATION:
            raise ArchiveCreationCancelled()
        if self.fault is not None:
            raise RuntimeError(f"injected creation {self.fault.value}")
        assert await is_cancelled() is False
        await on_member_completed(ArchiveCreationMemberOutcome("entry.txt", "created", 5))
        return ArchiveCreationResult(files_created=1, directories_created=0, source_bytes=5)


def _creation_trace_summary(checkpoint: dict[str, Any], expected: dict[str, Any] | None) -> dict[str, int] | None:
    if expected is None:
        return None
    summary = creation_outcome_summary(checkpoint)
    return {key: getattr(summary, key) for key in expected}


def _backend_creation_trace(case: FixtureCase) -> dict[str, Any]:
    operation = ArchiveOperation(
        user_id=uuid.uuid4(),
        kind=ArchiveOperationKind.CREATE,
        source_connection_id=case.topology.source_connection_id,
        destination_connection_id=case.topology.destination_connection_id,
    )
    creation_plan = ArchiveCreationExecutionPlan(
        ArchiveCreationManifest.from_members([ArchiveCreationManifestMember("entry.txt", False, 5, "entry.txt", None)])
    )
    state_store = TraceRecordingStateStore()
    try:
        completed = asyncio.run(
            ArchiveCreationCoordinator(operation, state_store).run(
                DeterministicCreationAdapter(case.fault).run, execution_plan=creation_plan
            )
        )
    except HTTPException:
        assert case.fault not in {None, AdapterFault.CANCELLATION}
        completed = operation
        error_category = "invalid_input" if case.fault == AdapterFault.MALFORMED_INPUT else case.fault.value
    else:
        error_category = "cancelled" if case.fault == AdapterFault.CANCELLATION else None
    checkpoint: dict[str, Any] = json.loads(completed.checkpoint_json)
    return {
        "owner": case.topology.driver.value,
        "manifest_snapshot": [member.archive_path for member in creation_plan.manifest.members],
        "phase_transitions": state_store.phase_transitions,
        "pending_decision": None,
        "member_outcomes": sorted(checkpoint["member_outcomes"]),
        "terminal_summary": _creation_trace_summary(checkpoint, case.expected_trace["terminal_summary"]),
        "error_category": error_category,
    }


@pytest.mark.parametrize("case", BACKEND_FIXTURE_CASES, ids=lambda case: case.name)
def test_backend_fixture_dispatcher_runs_every_backend_owned_case(case: FixtureCase) -> None:
    assert case.operation == ArchiveOperationKind.CREATE.value
    resolved = resolve_archive_operation_topology_plan(
        kind=ArchiveOperationKind(case.operation),
        source_connection_id=case.topology.source_connection_id,
        destination_connection_id=case.topology.destination_connection_id,
    )
    assert resolved.topology.driver == ArchiveExecutionDriver.BACKEND
    trace = _backend_creation_trace(case)
    assert trace == case.expected_trace


@pytest.mark.parametrize("case", BACKEND_TOPOLOGY_CASES, ids=lambda case: case.name)
def test_cross_topology_creation_harness_runs_resolved_coordinator(case: TopologyCase) -> None:
    plan = resolve_archive_operation_topology_plan(
        kind=ArchiveOperationKind.CREATE,
        source_connection_id=case.source_connection_id,
        destination_connection_id=case.destination_connection_id,
    )
    assert plan.topology.driver == case.driver
    operation = ArchiveOperation(
        user_id=uuid.uuid4(),
        kind=ArchiveOperationKind.CREATE,
        source_connection_id=case.source_connection_id,
        destination_connection_id=case.destination_connection_id,
    )
    creation_plan = ArchiveCreationExecutionPlan(
        ArchiveCreationManifest.from_members([ArchiveCreationManifestMember("entry.txt", False, 5, "entry.txt", None)])
    )

    state_store = TraceRecordingStateStore()
    completed = asyncio.run(
        ArchiveCreationCoordinator(operation, state_store).run(DeterministicCreationAdapter().run, execution_plan=creation_plan)
    )

    expected = _expected_trace(f"create_{case.name}_success")
    checkpoint: dict[str, Any] = json.loads(completed.checkpoint_json)
    assert {
        "owner": case.driver.value,
        "manifest_snapshot": [member.archive_path for member in creation_plan.manifest.members],
        "phase_transitions": state_store.phase_transitions,
        "pending_decision": None,
        "member_outcomes": sorted(checkpoint["member_outcomes"]),
        "terminal_summary": _creation_trace_summary(checkpoint, expected["terminal_summary"]),
        "error_category": None,
    } == expected


@pytest.mark.parametrize(
    "trajectory",
    tuple(case for case in BACKEND_TRAJECTORY_CASES if case.operation == "create"),
    ids=lambda case: f"{case.topology.name}-{case.scenario_name}",
)
def test_cross_topology_creation_harness_replays_shared_trajectory(
    trajectory: TrajectoryCase,
) -> None:
    case = trajectory.topology
    assert trajectory.expected_trace is not None
    scenario = next(scenario for scenario in CREATION_TRAJECTORIES if scenario["name"] == trajectory.scenario_name)
    resolved = resolve_archive_operation_topology_plan(
        kind=ArchiveOperationKind.CREATE,
        source_connection_id=case.source_connection_id,
        destination_connection_id=case.destination_connection_id,
    )
    assert resolved.topology.driver == ArchiveExecutionDriver.BACKEND
    operation = ArchiveOperation(
        user_id=uuid.uuid4(),
        kind=ArchiveOperationKind.CREATE,
        source_connection_id=case.source_connection_id,
        destination_connection_id=case.destination_connection_id,
    )
    creation_plan = ArchiveCreationExecutionPlan(
        ArchiveCreationManifest.from_members(
            [
                ArchiveCreationManifestMember(entry["archive_path"], entry["is_directory"], entry["source_size"], None, None)
                for entry in scenario["entries"]
            ]
        )
    )
    reports = [step for step in scenario["steps"] if step["event"] == "report"]
    cancelled = any(step["event"] == "cancel" for step in scenario["steps"])

    async def run(on_member_completed, is_cancelled) -> ArchiveCreationResult:
        for report in reports:
            await on_member_completed(ArchiveCreationMemberOutcome(report["archive_path"], report["status"], report["source_bytes"]))
        if cancelled:
            raise ArchiveCreationCancelled()
        assert await is_cancelled() is False
        return ArchiveCreationResult(**scenario["progress"])

    state_store = TraceRecordingStateStore()
    completed = asyncio.run(ArchiveCreationCoordinator(operation, state_store).run(run, execution_plan=creation_plan))

    checkpoint: dict[str, Any] = json.loads(completed.checkpoint_json)
    assert {
        "owner": case.driver.value,
        "manifest_snapshot": [member.archive_path for member in creation_plan.manifest.members],
        "phase_transitions": state_store.phase_transitions,
        "pending_decision": state_store.pending_decision,
        "member_outcomes": sorted(checkpoint["member_outcomes"]),
        "terminal_summary": _creation_trace_summary(checkpoint, trajectory.expected_trace["terminal_summary"]),
        "error_category": "cancelled" if completed.phase == ArchiveOperationPhase.CANCELLED else None,
    } == trajectory.expected_trace

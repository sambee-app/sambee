import importlib.util
from pathlib import Path

WORKSPACE = Path(__file__).parents[2]
SCRIPT_PATH = WORKSPACE / ".github/scripts/companion_build_required.py"
SPEC = importlib.util.spec_from_file_location("companion_build_required", SCRIPT_PATH)
assert SPEC is not None
assert SPEC.loader is not None
companion_build_required = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(companion_build_required)


def make_reader(files: dict[tuple[str, str], str]):
    def read_file(revision: str, path: str) -> str:
        return files[(revision, path)]

    return read_file


def test_version_sync_changes_do_not_require_a_companion_build() -> None:
    base = "base"
    head = "head"
    path = "companion/src-tauri/Cargo.toml"
    files = {
        (base, path): '[package]\nname = "sambee-companion"\nversion = "0.9.22"\n',
        (head, path): '[package]\nname = "sambee-companion"\nversion = "0.9.23"\n',
    }

    assert not companion_build_required.requires_companion_build({"VERSION", path}, make_reader(files), base, head)


def test_version_sync_changes_ignore_unrelated_pull_request_files() -> None:
    base = "base"
    head = "head"
    path = "companion/package.json"
    files = {
        (base, path): '{"version": "0.9.22"}',
        (head, path): '{"version": "0.9.23"}',
    }

    assert not companion_build_required.requires_companion_build(
        {"VERSION", path, "backend/app/api/connections.py", "frontend/src/App.tsx"},
        make_reader(files),
        base,
        head,
    )


def test_non_version_companion_metadata_changes_require_a_build() -> None:
    base = "base"
    head = "head"
    path = "companion/package.json"
    files = {
        (base, path): '{"version": "0.9.22", "scripts": {"test": "vitest"}}',
        (head, path): '{"version": "0.9.23", "scripts": {"test": "vitest --run"}}',
    }

    assert companion_build_required.requires_companion_build({"VERSION", path}, make_reader(files), base, head)


def test_companion_source_changes_require_a_build() -> None:
    assert companion_build_required.requires_companion_build(
        {"VERSION", "companion/src/App.tsx"}, lambda _revision, _path: "", "base", "head"
    )


def test_companion_build_input_changes_require_a_build() -> None:
    assert companion_build_required.requires_companion_build(
        {"VERSION", "scripts/check_tauri_version_alignment.py"},
        lambda _revision, _path: "",
        "base",
        "head",
    )


def test_shared_regional_locale_pattern_change_requires_a_build() -> None:
    assert companion_build_required.requires_companion_build({"shared/regional-locale-pattern.txt"}, make_reader({}), "base", "head")

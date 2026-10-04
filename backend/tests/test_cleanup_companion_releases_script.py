from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "cleanup_companion_releases.py"


def load_cleanup_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cleanup_companion_releases", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def release(release_id: int, tag_name: str | None, *, draft: bool = False, prerelease: bool = False) -> object:
    module = load_cleanup_module()
    return module.Release(release_id, tag_name, draft, prerelease, f"2026-08-{release_id:02d}T00:00:00Z")


def write_tauri_marker(root: Path, channel: str, version: str, tag: str, asset_name: str = "Sambee.AppImage") -> None:
    path = root / "docs" / "feeds" / "companion" / "tauri" / channel / "latest.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "version": version,
                "platforms": {
                    "linux-x86_64": {
                        "url": f"https://github.com/sambee-app/sambee-companion/releases/download/{tag}/{asset_name}",
                        "signature": "inline-signature",
                    }
                },
            }
        ),
        encoding="utf-8",
    )


def configure_main(monkeypatch: pytest.MonkeyPatch, module: ModuleType, root: Path) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "cleanup",
            "--release-repo-path",
            str(root),
            "--release-owner",
            "sambee-app",
            "--release-repo",
            "sambee-companion",
        ],
    )


@pytest.mark.unit
def test_tauri_marker_uses_bundle_url_and_inline_signature(tmp_path: Path) -> None:
    module = load_cleanup_module()
    write_tauri_marker(tmp_path, "test", "1.2.3", "companion-v1.2.3")

    markers = module.load_markers(tmp_path, "sambee-app", "sambee-companion")

    assert markers == [
        module.Marker(
            "test",
            (1, 2, 3),
            "companion-v1.2.3",
            frozenset({"Sambee.AppImage"}),
        )
    ]


@pytest.mark.unit
def test_marker_rejects_mismatched_release_versions(tmp_path: Path) -> None:
    module = load_cleanup_module()
    write_tauri_marker(tmp_path, "test", "1.2.3", "companion-v1.2.4")

    with pytest.raises(RuntimeError, match="does not match"):
        module.load_markers(tmp_path, "sambee-app", "sambee-companion")


@pytest.mark.unit
def test_marker_rejects_foreign_release_assets(tmp_path: Path) -> None:
    module = load_cleanup_module()
    path = tmp_path / "docs" / "feeds" / "sambee" / "companion" / "latest.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "version": "1.2.3",
                "assets": {"linux-x64": "https://github.com/other/repository/releases/download/companion-v1.2.3/Sambee.AppImage"},
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="must reference"):
        module.load_markers(tmp_path, "sambee-app", "sambee-companion")


@pytest.mark.unit
def test_cleanup_keeps_markers_and_latest_published_series(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_cleanup_module()
    write_tauri_marker(tmp_path, "test", "1.0.1", "companion-v1.0.1")
    releases = [
        module.Release(1, "companion-v1.0.0", False, False, "2026-08-01T00:00:00Z"),
        module.Release(2, "companion-v1.0.1", False, False, "2026-08-02T00:00:00Z"),
        module.Release(3, "companion-v1.0.2", False, False, "2026-08-03T00:00:00Z"),
        module.Release(4, "companion-v2.0.1", False, False, "2026-08-04T00:00:00Z"),
        module.Release(5, "companion-v1.0.9", True, False, "2026-08-05T00:00:00Z"),
        module.Release(6, "companion-v1.0.10", False, True, "2026-08-06T00:00:00Z"),
    ]
    deleted_ids: list[int] = []
    monkeypatch.setattr(module, "load_releases", lambda *_args: releases)
    monkeypatch.setattr(module, "load_release_asset_names", lambda *_args: {"Sambee.AppImage"})
    monkeypatch.setattr(
        module,
        "delete_release",
        lambda _owner, _repo, release_id, _token: deleted_ids.append(release_id),
    )
    configure_main(monkeypatch, module, tmp_path)

    assert module.main() == 0
    assert deleted_ids == [6, 5, 1]


@pytest.mark.unit
def test_cleanup_never_deletes_when_marker_asset_is_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_cleanup_module()
    write_tauri_marker(tmp_path, "test", "1.0.1", "companion-v1.0.1")
    releases = [module.Release(1, "companion-v1.0.1", False, False, "2026-08-01T00:00:00Z")]
    monkeypatch.setattr(module, "load_releases", lambda *_args: releases)
    monkeypatch.setattr(module, "load_release_asset_names", lambda *_args: set())
    monkeypatch.setattr(module, "delete_release", pytest.fail)
    configure_main(monkeypatch, module, tmp_path)

    with pytest.raises(RuntimeError, match="missing release assets"):
        module.main()


@pytest.mark.unit
def test_cleanup_rejects_marker_reference_to_draft_before_deletion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_cleanup_module()
    write_tauri_marker(tmp_path, "test", "1.0.1", "companion-v1.0.1")
    releases = [module.Release(1, "companion-v1.0.1", True, False, "2026-08-01T00:00:00Z")]
    monkeypatch.setattr(module, "load_releases", lambda *_args: releases)
    monkeypatch.setattr(module, "delete_release", pytest.fail)
    configure_main(monkeypatch, module, tmp_path)

    with pytest.raises(RuntimeError, match="draft or prerelease"):
        module.main()


@pytest.mark.unit
def test_cleanup_rejects_duplicate_release_tags_before_deletion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_cleanup_module()
    releases = [
        module.Release(1, "companion-v1.0.1", False, False, "2026-08-01T00:00:00Z"),
        module.Release(2, "companion-v1.0.1", False, False, "2026-08-02T00:00:00Z"),
    ]
    monkeypatch.setattr(module, "load_releases", lambda *_args: releases)
    monkeypatch.setattr(module, "delete_release", pytest.fail)
    configure_main(monkeypatch, module, tmp_path)

    with pytest.raises(RuntimeError, match="duplicate release tags"):
        module.main()

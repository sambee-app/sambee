from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Literal
from urllib.request import Request

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / ".github" / "scripts" / "cleanup_signature_container_versions.py"


def load_cleanup_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("cleanup_signature_container_versions", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, status: int, payload: bytes = b"") -> None:
        self.status = status
        self._payload = payload

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> Literal[False]:
        return False

    def read(self) -> bytes:
        return self._payload


@pytest.mark.unit
@pytest.mark.parametrize(
    ("owner", "owner_type", "owner_path"),
    [
        ("example-user", "User", "users/example-user"),
        ("sambee-app", "Organization", "orgs/sambee-app"),
    ],
)
def test_load_versions_uses_name_field_as_digest_fallback(
    monkeypatch: pytest.MonkeyPatch, owner: str, owner_type: str, owner_path: str
) -> None:
    module = load_cleanup_module()
    payload = [
        {
            "id": 1,
            "name": "sha256:" + "a" * 64,
            "created_at": "2026-05-17T00:00:00Z",
            "metadata": {
                "container": {
                    "tags": ["test"],
                }
            },
        }
    ]

    requested_urls: list[str] = []

    def urlopen(request: Request) -> FakeResponse:
        requested_urls.append(request.full_url)
        return FakeResponse(200, json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(module.urllib.request, "urlopen", urlopen)

    versions = module.load_versions(owner, owner_type, "sambee", "token")

    assert [version.digest for version in versions] == ["sha256:" + "a" * 64]
    assert requested_urls == [f"https://api.github.com/{owner_path}/packages/container/sambee/versions?page=1&per_page=100"]


@pytest.mark.unit
def test_retained_image_digests_keep_releases_and_protected_test_channel() -> None:
    module = load_cleanup_module()
    release_digest = "sha256:" + "1" * 64
    protected_test_digest = "sha256:" + "2" * 64
    sha_only_preview_digest = "sha256:" + "3" * 64
    untagged_child_digest = "sha256:" + "4" * 64
    versions = [
        module.PackageVersion(
            version_id=1,
            created_at="2026-05-17T00:00:00Z",
            digest=release_digest,
            tags=["0.7.0", "stable"],
        ),
        module.PackageVersion(
            version_id=2,
            created_at="2026-05-17T00:03:00Z",
            digest=protected_test_digest,
            tags=["sha-" + "a" * 40, "test"],
        ),
        module.PackageVersion(
            version_id=3,
            created_at="2026-05-17T00:01:00Z",
            digest=sha_only_preview_digest,
            tags=["sha-" + "b" * 40],
        ),
        module.PackageVersion(
            version_id=4,
            created_at="2026-05-17T00:04:00Z",
            digest=untagged_child_digest,
            tags=[],
        ),
    ]

    assert module.retained_image_digests(versions) == {
        release_digest,
        protected_test_digest,
    }


@pytest.mark.unit
def test_supported_arch_specific_preview_tags_are_not_retained() -> None:
    module = load_cleanup_module()
    preview_digest = "sha256:" + "5" * 64

    versions = [
        module.PackageVersion(
            version_id=1,
            created_at="2026-05-17T00:00:00Z",
            digest=preview_digest,
            tags=["sha-" + "a" * 40 + "-amd64"],
        )
    ]

    assert module.is_test_only_image_tag("sha-" + "a" * 40 + "-amd64")
    assert module.retained_image_digests(versions) == set()


@pytest.mark.unit
def test_run_scoped_staging_tags_are_not_retained() -> None:
    module = load_cleanup_module()
    staging_digest = "sha256:" + "6" * 64

    versions = [
        module.PackageVersion(
            version_id=1,
            created_at="2026-05-17T00:00:00Z",
            digest=staging_digest,
            tags=["staging-123456-2-index"],
        )
    ]

    assert module.is_test_only_image_tag("staging-123456-2-index")
    assert module.is_test_only_image_tag("stage-123456-2-index")
    assert module.retained_image_digests(versions) == set()


@pytest.mark.unit
def test_classify_signature_version_protects_retained_digest_artifacts() -> None:
    module = load_cleanup_module()
    retained_digest = "sha256:" + "a" * 64
    retained_hex = retained_digest.removeprefix("sha256:")
    retained_digests = {retained_digest}

    assert (
        module.classify_signature_version(
            module.PackageVersion(
                version_id=1,
                created_at="2026-05-17T00:00:00Z",
                digest="sha256:" + "1" * 64,
                tags=[f"sha256-{retained_hex}"],
            ),
            retained_digests,
        )
        == "protected"
    )
    assert (
        module.classify_signature_version(
            module.PackageVersion(
                version_id=2,
                created_at="2026-05-17T00:00:00Z",
                digest="sha256:" + "2" * 64,
                tags=[f"sha256-{retained_hex}.meta"],
            ),
            retained_digests,
        )
        == "protected"
    )


@pytest.mark.unit
def test_classify_signature_version_deletes_stale_known_artifacts() -> None:
    module = load_cleanup_module()
    stale_hex = "b" * 64
    retained_digests = {"sha256:" + "a" * 64}

    for tag in [f"sha256-{stale_hex}", f"sha256-{stale_hex}.meta", f"sha256-{stale_hex}.sig"]:
        assert (
            module.classify_signature_version(
                module.PackageVersion(
                    version_id=1,
                    created_at="2026-05-17T00:00:00Z",
                    digest="sha256:" + "1" * 64,
                    tags=[tag],
                ),
                retained_digests,
            )
            == "stale-artifact"
        )


@pytest.mark.unit
def test_classify_signature_version_protects_unknown_and_untagged_versions() -> None:
    module = load_cleanup_module()
    retained_digests = {"sha256:" + "a" * 64}

    assert (
        module.classify_signature_version(
            module.PackageVersion(
                version_id=1,
                created_at="2026-05-17T00:00:00Z",
                digest="sha256:" + "1" * 64,
                tags=["manual-investigation"],
            ),
            retained_digests,
        )
        == "protected"
    )
    assert (
        module.classify_signature_version(
            module.PackageVersion(
                version_id=2,
                created_at="2026-05-17T00:00:00Z",
                digest="sha256:" + "2" * 64,
                tags=[],
            ),
            retained_digests,
        )
        == "untagged"
    )

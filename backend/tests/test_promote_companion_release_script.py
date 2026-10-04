import hashlib
import io
import json
import sys
import urllib.error
from email.message import Message
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / ".github/scripts/promote_companion_release.py"
SPEC = spec_from_file_location("promote_companion_release", SCRIPT)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def make_release(payload: bytes) -> tuple[dict, list[dict], dict[str, bytes]]:
    signature_payload = b"signature"
    expected_assets = [
        {
            "name": "Sambee Companion_1.2.3_x64-setup.exe",
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size": len(payload),
        },
        {
            "name": "Sambee Companion_1.2.3_x64-setup.exe.sig",
            "sha256": hashlib.sha256(signature_payload).hexdigest(),
            "size": len(signature_payload),
        },
    ]
    platform_assets = [
        {**expected_assets[0], "roles": ["installer", "updater"]},
        {**expected_assets[1], "roles": ["signature"]},
    ]
    release_manifest = {
        "schema_version": 1,
        "platforms": [
            {"platform": "windows-x64", "target": "x86_64-pc-windows-msvc", "manifest_sha256": "a" * 64, "assets": platform_assets}
        ],
    }
    release_manifest["manifest_sha256"] = MODULE.canonical_manifest_digest(release_manifest)
    release_manifest_bytes = json.dumps(release_manifest, indent=2, sort_keys=True).encode() + b"\n"
    expected_assets.append(
        {
            "name": MODULE.RELEASE_MANIFEST_ASSET_NAME,
            "sha256": hashlib.sha256(release_manifest_bytes).hexdigest(),
            "size": len(release_manifest_bytes),
        }
    )
    provenance = {
        "schema_version": 1,
        "build_tag": "build-v1.2.3",
        "release_tag": "companion-v1.2.3",
        "source_sha": "a" * 40,
        "version": "1.2.3",
        "artifact_manifest_sha256": hashlib.sha256(release_manifest_bytes).hexdigest(),
        "platforms": release_manifest["platforms"],
        "assets": expected_assets,
    }
    provenance_bytes = json.dumps(provenance, indent=2, sort_keys=True).encode() + b"\n"
    completion = {
        "schema_version": 1,
        "release_tag": "companion-v1.2.3",
        "artifact_manifest_sha256": provenance["artifact_manifest_sha256"],
        "provenance_sha256": hashlib.sha256(provenance_bytes).hexdigest(),
        "expected_assets": expected_assets,
        "expected_assets_sha256": MODULE.expected_asset_set_digest(expected_assets),
    }
    completion_bytes = json.dumps(completion, indent=2, sort_keys=True).encode() + b"\n"
    urls = {
        "https://example.test/setup": payload,
        "https://example.test/provenance": provenance_bytes,
        "https://example.test/completion": completion_bytes,
        "https://example.test/manifest": release_manifest_bytes,
    }
    assets = [
        {"name": "Sambee.Companion_1.2.3_x64-setup.exe", "size": len(payload), "browser_download_url": "https://example.test/setup"},
        {
            "name": "Sambee.Companion_1.2.3_x64-setup.exe.sig",
            "size": len(signature_payload),
            "browser_download_url": "https://example.test/signature",
        },
        {
            "name": MODULE.RELEASE_MANIFEST_ASSET_NAME,
            "size": len(release_manifest_bytes),
            "browser_download_url": "https://example.test/manifest",
        },
        {"name": MODULE.PROVENANCE_ASSET_NAME, "size": len(provenance_bytes), "browser_download_url": "https://example.test/provenance"},
        {
            "name": MODULE.COMPLETION_MARKER_ASSET_NAME,
            "size": len(completion_bytes),
            "browser_download_url": "https://example.test/completion",
        },
    ]
    urls["https://example.test/signature"] = signature_payload
    return {"id": 123, "tag_name": "companion-v1.2.3"}, assets, urls


def test_verify_release_integrity_accepts_matching_assets(monkeypatch: pytest.MonkeyPatch) -> None:
    release, assets, urls = make_release(b"installer")
    monkeypatch.setattr(MODULE, "request_bytes", urls.__getitem__)

    MODULE.verify_release_integrity(release, assets)


def test_verify_release_integrity_authenticates_asset_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    release, assets, urls = make_release(b"installer")
    received_tokens = []

    def request_asset(asset: dict, token: str | None = None) -> bytes:
        received_tokens.append(token)
        return urls[asset["browser_download_url"]]

    monkeypatch.setattr(MODULE, "request_asset_bytes", request_asset)

    MODULE.verify_release_integrity(release, assets, "release-token")

    assert received_tokens
    assert set(received_tokens) == {"release-token"}


def test_request_asset_bytes_retries_transient_connection_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    asset = {"name": "manifest.json", "url": "https://api.github.test/asset"}
    responses = [
        urllib.error.URLError(ConnectionResetError(104, "Connection reset by peer")),
        io.BytesIO(b"asset contents"),
    ]
    retry_delays: list[int] = []

    def urlopen(_request: object) -> io.BytesIO:
        response = responses.pop(0)
        if isinstance(response, urllib.error.URLError):
            raise response
        return response

    monkeypatch.setattr(MODULE.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(MODULE.time, "sleep", retry_delays.append)

    assert MODULE.request_asset_bytes(asset, "release-token") == b"asset contents"
    assert retry_delays == [MODULE.ASSET_DOWNLOAD_INITIAL_RETRY_DELAY_SECONDS]


def test_request_asset_bytes_does_not_retry_permanent_http_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    asset = {"name": "manifest.json", "url": "https://api.github.test/asset"}
    request_count = 0

    def urlopen(_request: object) -> io.BytesIO:
        nonlocal request_count
        request_count += 1
        raise urllib.error.HTTPError(asset["url"], 404, "Not Found", Message(), io.BytesIO(b"not found"))

    monkeypatch.setattr(MODULE.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(
        MODULE.time,
        "sleep",
        lambda _delay: pytest.fail("Permanent HTTP errors must not be retried"),
    )

    with pytest.raises(SystemExit):
        MODULE.request_asset_bytes(asset, "release-token")

    assert request_count == 1
    assert "after 1 attempt(s)" in capsys.readouterr().err


def test_verify_release_integrity_rejects_tampered_asset(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    release, assets, urls = make_release(b"installer")
    urls["https://example.test/setup"] = b"malicious"
    monkeypatch.setattr(MODULE, "request_bytes", urls.__getitem__)

    with pytest.raises(SystemExit):
        MODULE.verify_release_integrity(release, assets)
    assert "checksum mismatch" in capsys.readouterr().err


def test_verify_release_integrity_rejects_tampered_completion_asset_set(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    release, assets, urls = make_release(b"installer")
    completion = json.loads(urls["https://example.test/completion"])
    completion["expected_assets_sha256"] = "0" * 64
    urls["https://example.test/completion"] = json.dumps(completion).encode()
    monkeypatch.setattr(MODULE, "request_bytes", urls.__getitem__)

    with pytest.raises(SystemExit):
        MODULE.verify_release_integrity(release, assets)
    assert "asset-set digest" in capsys.readouterr().err


def test_verify_release_integrity_rejects_unmanifested_release_asset(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    release, assets, urls = make_release(b"installer")
    assets.append({"name": "unexpected.bin", "size": 1, "browser_download_url": "https://example.test/unexpected"})
    urls["https://example.test/unexpected"] = b"x"
    monkeypatch.setattr(MODULE, "request_bytes", urls.__getitem__)

    with pytest.raises(SystemExit):
        MODULE.verify_release_integrity(release, assets)
    error_output = capsys.readouterr().err
    assert "unexpected or missing assets" in error_output
    assert "unexpected: unexpected.bin" in error_output


def test_verify_release_integrity_rejects_missing_manifested_release_asset(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    release, assets, urls = make_release(b"installer")
    assets[:] = [asset for asset in assets if asset["name"] != "Sambee.Companion_1.2.3_x64-setup.exe.sig"]
    monkeypatch.setattr(MODULE, "request_bytes", urls.__getitem__)

    with pytest.raises(SystemExit):
        MODULE.verify_release_integrity(release, assets)
    error_output = capsys.readouterr().err
    assert "unexpected or missing assets" in error_output
    assert "missing: Sambee.Companion_1.2.3_x64-setup.exe.sig" in error_output


def test_verify_release_integrity_rejects_release_version_mismatch(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    release, assets, urls = make_release(b"installer")
    release["tag_name"] = "companion-v1.2.4"
    monkeypatch.setattr(MODULE, "request_bytes", urls.__getitem__)

    with pytest.raises(SystemExit):
        MODULE.verify_release_integrity(release, assets)
    assert "does not match the selected release tag and version" in capsys.readouterr().err


def test_completion_asset_set_digest_is_order_independent_and_excludes_its_marker() -> None:
    release, _assets, urls = make_release(b"installer")
    completion = json.loads(urls["https://example.test/completion"])
    expected_assets = completion["expected_assets"]

    assert MODULE.COMPLETION_MARKER_ASSET_NAME not in {asset["name"] for asset in expected_assets}
    assert completion["expected_assets_sha256"] == MODULE.expected_asset_set_digest(list(reversed(expected_assets)))
    assert release["tag_name"] == completion["release_tag"]


def test_fetch_release_resolves_a_matching_github_release_url(monkeypatch: pytest.MonkeyPatch) -> None:
    requested_urls = []

    def request(url: str, _token: str) -> dict:
        requested_urls.append(url)
        return {"id": 123, "tag_name": "companion-v1.2.3"}

    monkeypatch.setattr(MODULE, "request_json", request)

    release = MODULE.fetch_release(
        "https://github.com/Sambee-App/Sambee-Companion/releases/tag/companion-v1.2.3?view=1#notes",
        "sambee-app",
        "sambee-companion",
        "token",
    )

    assert release["id"] == 123
    assert requested_urls == ["https://api.github.com/repos/sambee-app/sambee-companion/releases/tags/companion-v1.2.3"]


def test_fetch_release_preserves_slashes_in_github_release_url_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    requested_urls = []

    def request(url: str, _token: str) -> dict:
        requested_urls.append(url)
        return {"id": 123, "tag_name": "companion-v1.2.3/rc.1"}

    monkeypatch.setattr(MODULE, "request_json", request)

    MODULE.fetch_release(
        "https://github.com/sambee-app/sambee-companion/releases/tag/companion-v1.2.3%2Frc.1/",
        "sambee-app",
        "sambee-companion",
        "token",
    )

    assert requested_urls == ["https://api.github.com/repos/sambee-app/sambee-companion/releases/tags/companion-v1.2.3%2Frc.1"]


@pytest.mark.parametrize(
    "release_url",
    [
        "https://github.com/other/repository/releases/tag/companion-v1.2.3",
        "https://github.com/helgeklein/sambee-companion/releases/tag/companion-v1.2.3",
    ],
)
def test_fetch_release_rejects_foreign_github_release_urls(capsys: pytest.CaptureFixture[str], release_url: str) -> None:
    with pytest.raises(SystemExit):
        MODULE.fetch_release(
            release_url,
            "sambee-app",
            "sambee-companion",
            "token",
        )
    assert "must refer" in capsys.readouterr().err


def test_resolve_release_returns_verified_identity_and_provenance(monkeypatch: pytest.MonkeyPatch) -> None:
    release, assets, urls = make_release(b"installer")
    release.update({"draft": False, "prerelease": False, "assets": assets})
    monkeypatch.setattr(MODULE, "fetch_release", lambda *_args: release)
    monkeypatch.setattr(
        MODULE,
        "request_asset_bytes",
        lambda asset, _token=None: urls[asset["browser_download_url"]],
    )

    assert MODULE.resolve_release("companion-v1.2.3", "owner", "repo", "token") == {
        "release_id": 123,
        "release_tag": "companion-v1.2.3",
        "build_tag": "build-v1.2.3",
        "source_sha": "a" * 40,
    }


def test_resolve_release_rejects_github_prereleases(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    release, assets, _urls = make_release(b"installer")
    release.update({"draft": False, "prerelease": True, "assets": assets})
    monkeypatch.setattr(MODULE, "fetch_release", lambda *_args: release)

    with pytest.raises(SystemExit):
        MODULE.resolve_release("companion-v1.2.3", "owner", "repo", "token")
    assert "GitHub prerelease" in capsys.readouterr().err


def test_main_resolves_release_to_machine_readable_json(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "token")
    monkeypatch.setattr(
        MODULE,
        "resolve_release",
        lambda *_args: {
            "release_id": 123,
            "release_tag": "companion-v1.2.3",
            "build_tag": "build-v1.2.3",
            "source_sha": "a" * 40,
        },
    )
    monkeypatch.setattr(
        MODULE.sys,
        "argv",
        [
            str(SCRIPT),
            "--resolve-release",
            "--release-ref",
            "https://github.com/sambee-app/sambee-companion/releases/tag/companion-v1.2.3",
            "--release-owner",
            "sambee-app",
            "--release-repo",
            "sambee-companion",
        ],
    )

    MODULE.main()

    assert json.loads(capsys.readouterr().out) == {
        "release_id": 123,
        "release_tag": "companion-v1.2.3",
        "build_tag": "build-v1.2.3",
        "source_sha": "a" * 40,
    }


def test_validate_expected_release_identity_rejects_mismatched_tag(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit):
        MODULE.validate_expected_release_identity(
            123,
            "companion-v1.2.3",
            123,
            "companion-v1.2.4",
        )
    assert "expected release tag" in capsys.readouterr().err


def test_build_promoted_releases_feed_aggregates_existing_feeds(tmp_path: Path) -> None:
    stable_feed = tmp_path / "companion" / "tauri" / "stable" / "latest.json"
    stable_feed.parent.mkdir(parents=True)
    stable_feed.write_text(
        json.dumps({"version": "1.2.3", "pub_date": "2026-08-14T12:00:00Z"}),
        encoding="utf-8",
    )
    sambee_feed = tmp_path / "sambee" / "companion" / "latest.json"
    sambee_feed.parent.mkdir(parents=True)
    sambee_feed.write_text(
        json.dumps({"version": "1.2.4", "published_at": "2026-08-15T12:00:00Z"}),
        encoding="utf-8",
    )

    assert MODULE.build_promoted_releases_feed(tmp_path) == {
        "schema_version": 1,
        "channels": {
            "stable": {"version": "1.2.3", "published_at": "2026-08-14T12:00:00Z"},
            "sambee": {"version": "1.2.4", "published_at": "2026-08-15T12:00:00Z"},
        },
    }


def test_build_promoted_releases_feed_rejects_malformed_existing_feed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    feed_path = tmp_path / "companion" / "tauri" / "test" / "latest.json"
    feed_path.parent.mkdir(parents=True)
    feed_path.write_text("not json", encoding="utf-8")

    with pytest.raises(SystemExit):
        MODULE.build_promoted_releases_feed(tmp_path)

    assert "is not valid JSON" in capsys.readouterr().err


def test_main_builds_promoted_releases_index_without_release_credentials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    feed_path = tmp_path / "docs" / "feeds" / "companion" / "tauri" / "test" / "latest.json"
    feed_path.parent.mkdir(parents=True)
    feed_path.write_text(
        json.dumps({"version": "1.2.3", "pub_date": "2026-08-14T12:00:00Z"}),
        encoding="utf-8",
    )
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(
        MODULE.sys,
        "argv",
        [
            str(SCRIPT),
            "--build-promoted-releases-index",
            "--release-repo-path",
            str(tmp_path),
        ],
    )

    MODULE.main()

    index_path = tmp_path / "docs" / "feeds" / MODULE.PROMOTED_RELEASES_FILE
    assert json.loads(index_path.read_text(encoding="utf-8")) == {
        "schema_version": 1,
        "channels": {"test": {"version": "1.2.3", "published_at": "2026-08-14T12:00:00Z"}},
    }

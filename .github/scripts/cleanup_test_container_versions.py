from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

MINOR_RE = re.compile(r"^\d+\.\d+$")
SHA_TAG_RE = re.compile(r"^sha-[0-9a-f]{40}$")
ARCH_PREVIEW_TAG_RE = re.compile(r"^sha-[0-9a-f]{40}-(?:amd64|arm64)$")
STAGING_TAG_RE = re.compile(r"^(?:staging|stage)-[0-9]+-[0-9]+-(?:amd64|arm64|index)$")
ISOLATED_STAGING_PACKAGE_NAME = "sambee-staging"


@dataclass
class PackageVersion:
    version_id: int
    created_at: str
    tags: list[str]


def api_request(url: str, token: str, method: str = "GET") -> object | None:
    request = urllib.request.Request(url, method=method)
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    with urllib.request.urlopen(request) as response:
        if response.status == 204:
            return None

        payload = response.read()
        if not payload:
            return None

        return json.load(io.BytesIO(payload))


def get_owner_type(owner: str, token: str) -> str:
    payload = api_request(f"https://api.github.com/users/{owner}", token)
    owner_type = payload.get("type", "")
    if owner_type not in {"Organization", "User"}:
        raise RuntimeError(f"Unsupported owner type for {owner!r}: {owner_type!r}")
    return owner_type


def build_versions_endpoint(
    owner: str, owner_type: str, package_name: str, page: int
) -> str:
    encoded_package = urllib.parse.quote(package_name, safe="")
    if owner_type == "Organization":
        base = f"https://api.github.com/orgs/{owner}/packages/container/{encoded_package}/versions"
    else:
        base = f"https://api.github.com/users/{owner}/packages/container/{encoded_package}/versions"
    return f"{base}?page={page}&per_page=100"


def build_delete_endpoint(
    owner: str, owner_type: str, package_name: str, version_id: int
) -> str:
    encoded_package = urllib.parse.quote(package_name, safe="")
    if owner_type == "Organization":
        return f"https://api.github.com/orgs/{owner}/packages/container/{encoded_package}/versions/{version_id}"
    return f"https://api.github.com/users/{owner}/packages/container/{encoded_package}/versions/{version_id}"


def build_package_endpoint(owner: str, owner_type: str, package_name: str) -> str:
    encoded_package = urllib.parse.quote(package_name, safe="")
    if owner_type == "Organization":
        return (
            f"https://api.github.com/orgs/{owner}/packages/container/{encoded_package}"
        )
    return f"https://api.github.com/users/{owner}/packages/container/{encoded_package}"


def load_versions(
    owner: str, owner_type: str, package_name: str, token: str
) -> list[PackageVersion]:
    versions: list[PackageVersion] = []
    page = 1
    while True:
        try:
            payload = api_request(
                build_versions_endpoint(owner, owner_type, package_name, page), token
            )
        except urllib.error.HTTPError as exc:
            if exc.code == 404 and page == 1:
                return []
            raise
        if not payload:
            break
        for item in payload:
            tags = item.get("metadata", {}).get("container", {}).get("tags", []) or []
            versions.append(
                PackageVersion(
                    version_id=item["id"],
                    created_at=item["created_at"],
                    tags=tags,
                )
            )
        if len(payload) < 100:
            break
        page += 1
    return versions


def is_protected_tag(tag: str) -> bool:
    if tag in {"stable", "beta", "test"}:
        return True

    return bool(MINOR_RE.fullmatch(tag))


def is_test_only_tag(tag: str) -> bool:
    return bool(
        SHA_TAG_RE.match(tag)
        or ARCH_PREVIEW_TAG_RE.match(tag)
        or STAGING_TAG_RE.match(tag)
    )


def is_disposable_staging_version(version: PackageVersion) -> bool:
    return not version.tags or all(
        STAGING_TAG_RE.fullmatch(tag) for tag in version.tags
    )


def classify(version: PackageVersion) -> str:
    if not version.tags:
        return "protected"
    if any(is_protected_tag(tag) for tag in version.tags):
        return "protected"
    return "deletable"


def emit_log(version: PackageVersion, classification: str, action: str) -> None:
    print(
        json.dumps(
            {
                "version_id": version.version_id,
                "created_at": version.created_at,
                "tags": version.tags,
                "classification": classification,
                "action": action,
            }
        )
    )


def delete_version(
    owner: str, owner_type: str, package_name: str, version_id: int, token: str
) -> None:
    endpoint = build_delete_endpoint(owner, owner_type, package_name, version_id)
    api_request(endpoint, token, method="DELETE")


def delete_package(owner: str, owner_type: str, package_name: str, token: str) -> None:
    if package_name != ISOLATED_STAGING_PACKAGE_NAME:
        raise RuntimeError(
            "Refusing to delete an entire package outside the isolated staging "
            f"package {ISOLATED_STAGING_PACKAGE_NAME!r}: {package_name!r}"
        )
    try:
        api_request(
            build_package_endpoint(owner, owner_type, package_name),
            token,
            method="DELETE",
        )
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise


def current_run_staging_pattern(staging_tag: str) -> re.Pattern[str]:
    match = re.fullmatch(r"stage-([0-9]+-[0-9]+)-index", staging_tag)
    if match is None:
        raise ValueError(f"Refusing to delete non-index stage tag: {staging_tag}")
    return re.compile(rf"^stage-{re.escape(match.group(1))}-(?:amd64|arm64|index)$")


def delete_exact_staging_tag(
    versions: list[PackageVersion],
    staging_tag: str,
    owner: str,
    owner_type: str,
    package_name: str,
    token: str,
) -> bool:
    run_tag_pattern = current_run_staging_pattern(staging_tag)

    matches = [version for version in versions if staging_tag in version.tags]
    if not matches:
        return False

    if all(
        not version.tags or all(run_tag_pattern.fullmatch(tag) for tag in version.tags)
        for version in versions
    ):
        delete_package(owner, owner_type, package_name, token)
        return True

    for version in matches:
        if not all(run_tag_pattern.fullmatch(tag) for tag in version.tags):
            raise RuntimeError(
                f"Refusing to delete package version {version.version_id}: "
                f"{staging_tag} shares it with tags outside the current run {version.tags}"
            )
        delete_version(owner, owner_type, package_name, version.version_id, token)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True)
    parser.add_argument("--package-name", required=True)
    parser.add_argument("--exact-staging-tag")
    parser.add_argument("--allow-package-delete", action="store_true")
    args = parser.parse_args()

    if args.allow_package_delete and args.package_name != ISOLATED_STAGING_PACKAGE_NAME:
        raise RuntimeError(
            "--allow-package-delete is only valid for the isolated staging "
            f"package {ISOLATED_STAGING_PACKAGE_NAME!r}"
        )

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required")

    owner_type = get_owner_type(args.owner, token)
    versions = load_versions(args.owner, owner_type, args.package_name, token)

    if args.exact_staging_tag:
        deleted = delete_exact_staging_tag(
            versions,
            args.exact_staging_tag,
            args.owner,
            owner_type,
            args.package_name,
            token,
        )
        if deleted:
            print(
                f"Deleted run-scoped staging package version for {args.exact_staging_tag}."
            )
        else:
            print(
                f"Run-scoped staging index {args.exact_staging_tag} was not present; nothing to delete."
            )
        return 0

    if (
        args.allow_package_delete
        and versions
        and all(is_disposable_staging_version(version) for version in versions)
    ):
        for version in versions:
            emit_log(version, "deletable", "delete-package-candidate")
        delete_package(args.owner, owner_type, args.package_name, token)
        print(f"Deleted disposable package {args.package_name}.")
        return 0

    deletable: list[PackageVersion] = []
    for version in versions:
        classification = classify(version)
        if classification == "deletable":
            deletable.append(version)
            emit_log(version, classification, "delete-candidate")
        else:
            emit_log(version, classification, "protect")

    deletable.sort(key=lambda version: version.created_at, reverse=True)
    for version in deletable:
        emit_log(version, "deletable", "delete")
        try:
            delete_version(
                args.owner, owner_type, args.package_name, version.version_id, token
            )
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"Failed to delete package version {version.version_id}: {exc}"
            ) from exc

    return 0


if __name__ == "__main__":
    sys.exit(main())

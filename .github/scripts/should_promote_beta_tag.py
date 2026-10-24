from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass

SEMVER_RE = re.compile(
    r"^(?P<core>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))"
    r"(?:-(?P<prerelease>[0-9A-Za-z.-]+))?(?:\+(?P<build>[0-9A-Za-z.-]+))?$"
)


@dataclass(frozen=True)
class SemVer:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...]


def parse_semver(version: str) -> SemVer:
    match = SEMVER_RE.fullmatch(version)
    if match is None:
        raise ValueError(f"Expected a semver version, got {version!r}")

    major_str, minor_str, patch_str = match.group("core").split(".")
    prerelease_raw = match.group("prerelease")
    prerelease = tuple(prerelease_raw.split(".")) if prerelease_raw else ()

    for identifier in prerelease:
        if not identifier:
            raise ValueError(f"Invalid semver prerelease identifier in {version!r}")
        if identifier.isdigit() and len(identifier) > 1 and identifier.startswith("0"):
            raise ValueError(
                f"Semver numeric prerelease identifiers must not contain leading zeroes: {version!r}"
            )

    return SemVer(
        major=int(major_str),
        minor=int(minor_str),
        patch=int(patch_str),
        prerelease=prerelease,
    )


def compare_identifiers(left: str, right: str) -> int:
    left_is_numeric = left.isdigit()
    right_is_numeric = right.isdigit()

    if left_is_numeric and right_is_numeric:
        left_value = int(left)
        right_value = int(right)
        return (left_value > right_value) - (left_value < right_value)

    if left_is_numeric != right_is_numeric:
        return -1 if left_is_numeric else 1

    return (left > right) - (left < right)


def compare_semver(left: SemVer, right: SemVer) -> int:
    left_core = (left.major, left.minor, left.patch)
    right_core = (right.major, right.minor, right.patch)

    if left_core != right_core:
        return (left_core > right_core) - (left_core < right_core)

    if not left.prerelease and not right.prerelease:
        return 0
    if not left.prerelease:
        return 1
    if not right.prerelease:
        return -1

    for left_identifier, right_identifier in zip(left.prerelease, right.prerelease):
        comparison = compare_identifiers(left_identifier, right_identifier)
        if comparison != 0:
            return comparison

    return (len(left.prerelease) > len(right.prerelease)) - (
        len(left.prerelease) < len(right.prerelease)
    )


def should_promote_beta_tag(candidate_version: str, beta_version: str | None) -> bool:
    candidate = parse_semver(candidate_version)

    if not beta_version:
        return True

    try:
        beta = parse_semver(beta_version)
    except ValueError:
        return True

    return compare_semver(beta, candidate) <= 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-version", required=True)
    parser.add_argument("--beta-version")
    args = parser.parse_args()

    decision = (
        "promote"
        if should_promote_beta_tag(args.candidate_version, args.beta_version)
        else "keep"
    )
    print(decision)
    return 0


if __name__ == "__main__":
    sys.exit(main())

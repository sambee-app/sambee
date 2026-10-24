"""Reserve or resolve the immutable source commit for a publishable build."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass

VERSION_PATTERN = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
CI_GIT_USER_NAME = "github-actions[bot]"
CI_GIT_USER_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"


class CandidateError(RuntimeError):
    """Raised when a build source cannot be safely selected."""


@dataclass(frozen=True)
class BuildCandidate:
    version: str
    tag: str
    source_sha: str
    tree_sha: str
    reserved: bool


def run_git(*arguments: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *arguments], text=True, capture_output=True, check=False
    )
    if check and result.returncode:
        message = result.stderr.strip() or result.stdout.strip()
        raise CandidateError(f"git {' '.join(arguments)} failed: {message}")
    return result.stdout.strip()


def validate_version(version: str) -> str:
    if not VERSION_PATTERN.fullmatch(version):
        raise CandidateError(
            "Publishable VERSION must be plain X.Y.Z with non-negative numeric "
            "components and no leading zeroes. Update VERSION, run "
            "./scripts/sync-version, commit on main, and rerun."
        )
    return version


def tag_name(version: str) -> str:
    return f"build-v{validate_version(version)}"


def read_version() -> str:
    with open("VERSION", encoding="ascii") as version_file:
        return validate_version(version_file.read().strip())


def resolve_tag(tag: str) -> str | None:
    target = run_git(
        "rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}", check=False
    )
    return target or None


def require_main_dispatch(dispatch_ref: str) -> None:
    if dispatch_ref != "refs/heads/main":
        raise CandidateError(
            "Candidate publishing must be dispatched from refs/heads/main; "
            f"received {dispatch_ref}."
        )


def require_main_ancestor(source_sha: str) -> None:
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", source_sha, "origin/main"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise CandidateError(
            f"Canonical build source {source_sha} is no longer reachable from origin/main."
        )


def reserve_or_resolve(
    *, dispatch_ref: str, dispatch_sha: str, build_version: str | None, run_url: str
) -> BuildCandidate:
    require_main_dispatch(dispatch_ref)
    run_git("fetch", "origin", "main", "--tags")

    if build_version:
        version = validate_version(build_version)
        tag = tag_name(version)
        source_sha = resolve_tag(tag)
        if source_sha is None:
            raise CandidateError(
                f"Canonical build tag {tag} does not exist. Select the version of an "
                "existing build-vX.Y.Z tag (for example, build-v1.0.33 -> 1.0.33)."
            )
        require_main_ancestor(source_sha)
        run_git("checkout", "--detach", source_sha)
        if read_version() != version:
            raise CandidateError(
                f"{tag} points to VERSION {read_version()}, not {version}."
            )
        return BuildCandidate(
            version,
            tag,
            source_sha,
            run_git("rev-parse", f"{source_sha}^{{tree}}"),
            False,
        )

    run_git("checkout", "--detach", dispatch_sha)
    version = read_version()
    tag = tag_name(version)
    existing_sha = resolve_tag(tag)
    if existing_sha:
        if existing_sha != dispatch_sha:
            raise CandidateError(
                f"{tag} is already bound to {existing_sha}, not {dispatch_sha}. "
                "Increment Z, synchronize metadata, commit on main, and rerun."
            )
        return BuildCandidate(
            version,
            tag,
            dispatch_sha,
            run_git("rev-parse", f"{dispatch_sha}^{{tree}}"),
            False,
        )

    message = f"Sambee build {version}\nsource_sha={dispatch_sha}\nworkflow={run_url}"
    run_git(
        "-c",
        f"user.name={CI_GIT_USER_NAME}",
        "-c",
        f"user.email={CI_GIT_USER_EMAIL}",
        "tag",
        "-a",
        tag,
        dispatch_sha,
        "-m",
        message,
    )
    push = subprocess.run(
        ["git", "push", "origin", f"refs/tags/{tag}"],
        text=True,
        capture_output=True,
        check=False,
    )
    if push.returncode:
        run_git("fetch", "origin", f"+refs/tags/{tag}:refs/tags/{tag}")
        existing_sha = resolve_tag(tag)
        if existing_sha != dispatch_sha:
            raise CandidateError(
                f"Concurrent reservation bound {tag} to {existing_sha}; expected {dispatch_sha}."
            )
        reserved = False
    else:
        reserved = True
    return BuildCandidate(
        version,
        tag,
        dispatch_sha,
        run_git("rev-parse", f"{dispatch_sha}^{{tree}}"),
        reserved,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dispatch-ref", required=True)
    parser.add_argument("--dispatch-sha", required=True)
    parser.add_argument("--build-version")
    parser.add_argument("--run-url", required=True)
    arguments = parser.parse_args()
    try:
        candidate = reserve_or_resolve(
            dispatch_ref=arguments.dispatch_ref,
            dispatch_sha=arguments.dispatch_sha,
            build_version=arguments.build_version,
            run_url=arguments.run_url,
        )
    except CandidateError as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    for key, value in {
        "version": candidate.version,
        "build_tag": candidate.tag,
        "source_sha": candidate.source_sha,
        "tree_sha": candidate.tree_sha,
        "reserved": str(candidate.reserved).lower(),
    }.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()

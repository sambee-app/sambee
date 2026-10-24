import re
from pathlib import Path

import yaml

WORKSPACE = Path(__file__).parents[2]


def load_workflow(name: str) -> dict:
    with (WORKSPACE / ".github/workflows" / name).open(encoding="utf-8") as file:
        payload = yaml.safe_load(file)
    assert isinstance(payload, dict)
    return payload


def load_action(name: str) -> dict:
    with (WORKSPACE / ".github/actions" / name / "action.yml").open(encoding="utf-8") as file:
        payload = yaml.safe_load(file)
    assert isinstance(payload, dict)
    return payload


def workflow_inputs(workflow: dict) -> dict:
    trigger = workflow.get("on", workflow.get(True, {}))
    assert isinstance(trigger, dict)
    dispatch = trigger.get("workflow_dispatch", {})
    assert isinstance(dispatch, dict)
    inputs = dispatch.get("inputs", {})
    assert isinstance(inputs, dict)
    return inputs


def step_uses(steps: list[dict], action: str) -> bool:
    return any(step.get("uses") == action for step in steps if isinstance(step, dict))


def test_companion_promotion_index_refresh_only_rewrites_the_generated_index() -> None:
    workflow = load_workflow("refresh-companion-promotion-index.yml")
    refresh_job = workflow["jobs"]["refresh"]
    steps = refresh_job["steps"]

    generate_step = next(step for step in steps if step.get("name") == "Generate current promotion index")
    assert "--build-promoted-releases-index" in generate_step["run"]
    assert "--release-repo-path" in generate_step["run"]

    push_step = next(step for step in steps if step.get("name") == "Commit and push promotion index")
    assert "git -C release-repo add docs/feeds/companion/promoted.json" in push_step["run"]
    assert "remote feed state is unknown" in push_step["run"]


def test_candidate_workflows_do_not_expose_source_or_version_overrides() -> None:
    docker = load_workflow("docker-image-preview-publish.yml")
    companion = load_workflow("build-companion.yml")

    forbidden_inputs = {"source_ref", "publish_version_override"}
    assert not forbidden_inputs & set(workflow_inputs(docker))
    assert not forbidden_inputs & set(workflow_inputs(companion))
    assert "build_version" in workflow_inputs(docker)
    assert "build_version" in workflow_inputs(companion)


def test_docker_release_reuses_only_verified_source_ci_jobs() -> None:
    workflow = load_workflow("docker-image-preview-publish.yml")
    validation = workflow["jobs"]["validate-tests"]
    steps = validation["steps"]
    lookup = next(step for step in steps if step.get("id") == "source-ci")

    assert validation["permissions"]["actions"] == "read"
    assert lookup["env"]["SOURCE_SHA"] == "${{ needs.prepare.outputs.checkout_ref }}"
    assert lookup["run"] == "python .github/scripts/reuse_release_ci_tests.py"

    backend_steps = (
        "Install backend system dependencies",
        "Install backend test dependencies",
        "Generate backend test images",
        "Run backend type checks",
        "Run backend tests (excluding performance)",
        "Run backend performance tests",
    )
    frontend_steps = (
        "Set up Node.js",
        "Install frontend dependencies",
        "Verify frontend type correctness",
        "Run frontend tests",
        "Build production frontend for browser checks",
        "Install browser dependencies",
        "Run browser correctness contracts",
    )
    for component, names in (("backend", backend_steps), ("frontend", frontend_steps)):
        for name in names:
            step = next(step for step in steps if step.get("name") == name)
            assert step["if"] == f"steps.source-ci.outputs.{component} != 'true'"


def test_candidate_matrix_builds_depend_on_shared_preflight() -> None:
    for workflow_name in (
        "docker-image-preview-publish.yml",
        "build-companion.yml",
        "create-public-release.yml",
    ):
        workflow = load_workflow(workflow_name)
        jobs = workflow["jobs"]
        preflight_job = jobs.get("prepare", jobs.get("create-release"))
        assert preflight_job is not None
        preflight_steps = preflight_job["steps"]
        preflight_index = next(
            index for index, step in enumerate(preflight_steps) if step.get("uses") == "./.github/actions/release-candidate-preflight"
        )
        assert any(step.get("uses", "").startswith("actions/checkout@") for step in preflight_steps[:preflight_index])

        if workflow_name != "create-public-release.yml":
            build_jobs = [job for name, job in jobs.items() if name.startswith("build")]
            assert build_jobs
            for job in build_jobs:
                needs = job.get("needs", [])
                if isinstance(needs, str):
                    needs = [needs]
                assert "prepare" in needs


def test_public_release_annotated_tag_has_explicit_ci_identity() -> None:
    workflow = load_workflow("create-public-release.yml")
    steps = workflow["jobs"]["create-release"]["steps"]
    tag_step = next(step for step in steps if step.get("name") == "Create or verify immutable public tag")

    assert "user.name='github-actions[bot]'" in tag_step["run"]
    assert "user.email='41898282+github-actions[bot]@users.noreply.github.com'" in tag_step["run"]
    assert "tag -a" in tag_step["run"]


def test_all_local_actions_follow_checkout_in_their_job() -> None:
    workflow_directory = WORKSPACE / ".github/workflows"
    for workflow_path in workflow_directory.glob("*.yml"):
        workflow = load_workflow(workflow_path.name)
        for job_name, job in workflow.get("jobs", {}).items():
            steps = job.get("steps", [])
            for index, step in enumerate(steps):
                if not step.get("uses", "").startswith("./.github/actions/"):
                    continue
                assert any(previous_step.get("uses", "").startswith("actions/checkout@") for previous_step in steps[:index]), (
                    f"{workflow_path.name}:{job_name} uses a local action before checkout"
                )


def test_all_repository_scripts_follow_checkout_in_their_job() -> None:
    workflow_directory = WORKSPACE / ".github/workflows"
    for workflow_path in workflow_directory.glob("*.yml"):
        workflow = load_workflow(workflow_path.name)
        for job_name, job in workflow.get("jobs", {}).items():
            steps = job.get("steps", [])
            for index, step in enumerate(steps):
                if ".github/scripts/" not in step.get("run", ""):
                    continue
                assert any(previous_step.get("uses", "").startswith("actions/checkout@") for previous_step in steps[:index]), (
                    f"{workflow_path.name}:{job_name} runs a repository script before checkout"
                )


def test_version_only_updates_skip_the_companion_package_build() -> None:
    workflow = load_workflow("verify-companion-build.yml")
    jobs = workflow["jobs"]

    change_scope = jobs["change-scope"]
    assert ".github/scripts/companion_build_required.py" in change_scope["steps"][-1]["run"]
    assert change_scope["outputs"]["requires-build"] == "${{ steps.scope.outputs.requires-build }}"

    package_build = jobs["windows-x64"]
    assert package_build["needs"] == "change-scope"
    assert package_build["if"] == "needs.change-scope.outputs.requires-build == 'true'"


def test_companion_verification_packages_are_never_signed() -> None:
    verification = load_workflow("verify-companion-build.yml")["jobs"]["windows-x64"]
    steps = verification["steps"]
    configure = next(step for step in steps if step.get("name") == "Configure verification-only Tauri bundle")
    release_steps = load_workflow("build-companion.yml")["jobs"]["build"]["steps"]

    assert not any(name.startswith("AZURE_") for name in verification["env"])
    assert "AZURE_CLIENT_ID" in next(step for step in steps if step.get("name") == "Assert verification-only secret boundary")["run"]
    assert "$config.bundle.windows.signCommand = $null" in configure["run"]
    assert "if (" not in configure["run"]
    assert not any("trusted-signing-cli" in step.get("run", "") for step in steps)
    assert any(step.get("name") == "Install trusted-signing-cli" for step in release_steps)


def test_workflow_output_references_use_direct_dependencies() -> None:
    dependency_pattern = re.compile(r"needs\.([A-Za-z0-9_-]+)\.outputs")
    workflow_directory = WORKSPACE / ".github/workflows"

    for workflow_path in workflow_directory.glob("*.yml"):
        workflow = load_workflow(workflow_path.name)
        for job_name, job in workflow.get("jobs", {}).items():
            needs = job.get("needs", [])
            if isinstance(needs, str):
                needs = [needs]
            assert isinstance(needs, list)
            direct_dependencies = set(needs)
            references = dependency_pattern.findall(yaml.safe_dump(job))
            assert set(references) <= direct_dependencies, (
                f"{workflow_path.name}:{job_name} reads outputs from non-direct dependencies: "
                f"{sorted(set(references) - direct_dependencies)}"
            )


def test_release_mutation_workflows_share_the_expected_locks() -> None:
    docker_candidate = load_workflow("docker-image-preview-publish.yml")
    docker_promotion = load_workflow("docker-image-publish.yml")
    docker_backfill = load_workflow("docker-image-backfill.yml")
    companion = load_workflow("build-companion.yml")

    for workflow in (docker_candidate, docker_promotion, docker_backfill):
        assert workflow["concurrency"]["group"] == "docker-release-publication"
        assert workflow["concurrency"]["cancel-in-progress"] is False
    assert companion["concurrency"]["group"] == "companion-release-publication"
    assert companion["concurrency"]["cancel-in-progress"] is False


def test_docker_candidate_workflow_selects_build_or_repair_before_build_jobs() -> None:
    workflow = load_workflow("docker-image-preview-publish.yml")
    prepare_steps = workflow["jobs"]["prepare"]["steps"]
    state_step = next(step for step in prepare_steps if step.get("name") == "Resolve Docker candidate publication state")

    assert 'echo "state=build"' in state_step["run"]
    assert 'echo "state=repair"' in state_step["run"]
    assert "verify_published_candidate_image.sh" in state_step["run"]
    assert '--candidate-digest "$candidate_digest"' in state_step["run"]
    assert "Published candidate verifier resolved" in state_step["run"]

    for job_name in ("validate-tests", "build-and-validate-platforms", "build-and-publish-immutable"):
        assert "publication_state == 'build'" in workflow["jobs"][job_name]["if"]
    for job_name in ("publish-immutable-markers", "promote-test-tag", "repair-candidate-aliases"):
        expected_state = "repair" if job_name == "repair-candidate-aliases" else "build"
        assert f"publication_state == '{expected_state}'" in workflow["jobs"][job_name]["if"]


def test_companion_promotion_does_not_require_a_public_sambee_release() -> None:
    workflow = load_workflow("promote-companion-release.yml")
    steps = workflow["jobs"]["promote"]["steps"]
    assert all(step.get("name") != "Verify coordinated Docker candidate" for step in steps)
    assert all(step.get("name") != "Install Cosign" for step in steps)
    assert all(step.get("name") != "Set up crane" for step in steps)
    assert all(step.get("name") != "Set up ORAS" for step in steps)


def test_docker_backfill_uses_signed_candidate_verifier() -> None:
    workflow = load_workflow("docker-image-backfill.yml")
    steps = workflow["jobs"]["verify-candidate-artifact"]["steps"]

    assert any(step.get("name") == "Install Cosign" for step in steps)
    verifier_step = next(step for step in steps if step.get("name") == "Verify signed published candidate")
    assert "verify_published_candidate_image.sh" in verifier_step["run"]
    assert '--candidate-digest "${{ needs.resolve-candidate-artifact.outputs.candidate_digest }}"' in verifier_step["run"]


def test_docker_promotion_uses_only_the_verifier_digest_for_aliases() -> None:
    workflow = load_workflow("docker-image-publish.yml")
    verifier_job = workflow["jobs"]["verify-candidate-artifact"]
    assert verifier_job["outputs"]["candidate_digest"] == "${{ steps.verify.outputs.resolved_digest }}"
    assert "sign-and-attest" not in workflow["jobs"]

    promotion_job = workflow["jobs"]["promote-release-tags"]
    assert promotion_job["needs"] == ["prepare", "verify-candidate-artifact"]
    run_steps = "\n".join(step.get("run", "") for step in promotion_job["steps"] if isinstance(step, dict))
    assert "needs.verify-candidate-artifact.outputs.candidate_digest" in run_steps

    repair_step = next(step for step in verifier_job["steps"] if step.get("name") == "Verify candidate repair aliases")
    assert "steps.verify.outputs.resolved_digest" in repair_step["run"]
    assert "build_version=${{ needs.prepare.outputs.version }}" in repair_step["run"]


def test_docker_promotion_has_a_beta_only_manual_path() -> None:
    workflow = load_workflow("docker-image-publish.yml")
    inputs = workflow_inputs(workflow)
    assert set(inputs) == {"build_version"}
    assert inputs["build_version"]["required"] is True

    prepare_steps = workflow["jobs"]["prepare"]["steps"]
    metadata_step = next(step for step in prepare_steps if step.get("name") == "Resolve release metadata")
    assert 'github.event_name }}" == "workflow_dispatch' in metadata_step["run"]
    assert "prepare_release_candidate.py" in metadata_step["run"]
    assert '--build-version "${{ inputs.build_version }}"' in metadata_step["run"]
    assert 'release_type="beta"' in metadata_step["run"]
    assert 'component_scope="docker"' in metadata_step["run"]

    assert "publish-release-tags" not in workflow["jobs"]
    promotion_job = workflow["jobs"]["promote-release-tags"]
    assert promotion_job["needs"] == ["prepare", "verify-candidate-artifact"]
    assert "release_type == 'stable'" in workflow["jobs"]["upload-metadata-release-assets"]["if"]
    assert "promote-release-tags" in workflow["jobs"]["upload-metadata-release-assets"]["needs"]

    verifier_steps = workflow["jobs"]["verify-candidate-artifact"]["steps"]
    verifier_step = next(step for step in verifier_steps if step.get("name") == "Verify signed published candidate")
    assert '--candidate-digest "${{ needs.resolve-candidate-artifact.outputs.candidate_digest }}"' in verifier_step["run"]
    coordinated_step = next(step for step in verifier_steps if step.get("name") == "Verify coordinated Companion release")
    assert "release_type == 'stable'" in coordinated_step["if"]

    promotion_steps = promotion_job["steps"]
    minor_step = next(step for step in promotion_steps if step.get("name") == "Attach minor-series tag")
    assert minor_step["if"] == "${{ needs.prepare.outputs.release_type == 'stable' }}"
    beta_policy_step = next(step for step in promotion_steps if step.get("name") == "Decide whether promotion should move beta")
    assert "if" not in beta_policy_step
    assert "--candidate-version" in beta_policy_step["run"]
    beta_step = next(step for step in promotion_steps if step.get("name") == "Promote beta channel tag")
    assert beta_step["if"] == "${{ needs.prepare.outputs.release_type == 'beta' && steps.beta-policy.outputs.decision == 'promote' }}"
    assert "needs.verify-candidate-artifact.outputs.candidate_digest" in beta_step["run"]


def test_docker_candidate_aliases_use_the_post_sign_verifier_digest() -> None:
    workflow = load_workflow("docker-image-preview-publish.yml")
    assembled_image_job = workflow["jobs"]["build-and-publish-immutable"]
    assembled_image_step = next(
        step for step in assembled_image_job["steps"] if step.get("name") == "Verify assembled preview image metadata"
    )
    assert (
        '--image-ref "${{ needs.prepare.outputs.staging_image_name }}@${{ steps.assemble.outputs.digest }}"' in assembled_image_step["run"]
    )
    assert "${{ needs.prepare.outputs.image_name }}@${{ steps.assemble.outputs.digest }}" not in assembled_image_step["run"]

    verifier_job = workflow["jobs"]["verify-signed-candidate"]
    assert verifier_job["needs"] == ["prepare", "verify-staged-candidate", "publish-final-marker"]
    assert verifier_job["outputs"]["candidate_digest"] == "${{ steps.verify.outputs.resolved_digest }}"

    verifier_steps = verifier_job["steps"]
    assert any(step.get("name") == "Install Cosign" for step in verifier_steps)
    verification_step = next(step for step in verifier_steps if step.get("name") == "Verify signed published candidate")
    assert "verify_published_candidate_image.sh" in verification_step["run"]
    assert '--candidate-digest "${{ needs.verify-staged-candidate.outputs.candidate_digest }}"' in verification_step["run"]

    staged_verifier_job = workflow["jobs"]["verify-staged-candidate"]
    assert staged_verifier_job["needs"] == ["prepare", "build-and-publish-immutable", "build-metadata-bundle", "sign-preview"]
    staged_verifier_step = next(step for step in staged_verifier_job["steps"] if step.get("name") == "Verify signed staged candidate")
    assert '--inspect-image-ref "$staging_ref"' in staged_verifier_step["run"]
    assert '--subject-image-ref "$final_ref"' in staged_verifier_step["run"]
    assert re.search(
        r'--expected-source "\$\{\{ needs\.prepare\.outputs\.source_url \}\}"\n\s*bash \.github/scripts/ensure_candidate_signature\.sh',
        staged_verifier_step["run"],
    )

    final_marker_job = workflow["jobs"]["publish-final-marker"]
    assert final_marker_job["needs"] == ["prepare", "verify-staged-candidate"]
    final_marker_step = next(
        step for step in final_marker_job["steps"] if step.get("name") == "Copy verified staging index to immutable final marker"
    )
    assert "promote_staged_container_image.sh" in final_marker_step["run"]
    assert '--target-tag "${{ needs.prepare.outputs.build_tag }}"' in final_marker_step["run"]

    signer_steps = workflow["jobs"]["sign-preview"]["steps"]
    signer_checkout_index = next(index for index, step in enumerate(signer_steps) if step.get("uses", "").startswith("actions/checkout@"))
    signer_index = next(index for index, step in enumerate(signer_steps) if step.get("name") == "Sign preview digest")
    assert signer_checkout_index < signer_index
    signer_step = signer_steps[signer_index]
    assert "ensure_candidate_signature.sh" in signer_step["run"]
    assert '--signature-repository "${{ needs.prepare.outputs.signature_repository }}"' in signer_step["run"]

    for job_name in ("publish-immutable-markers", "promote-test-tag"):
        job = workflow["jobs"][job_name]
        assert "verify-signed-candidate" in job["needs"]
        run_steps = "\n".join(step.get("run", "") for step in job["steps"] if isinstance(step, dict))
        assert "needs.verify-signed-candidate.outputs.candidate_digest" in run_steps


def test_docker_candidate_cleanup_and_summary_cover_staging_lifecycle() -> None:
    workflow = load_workflow("docker-image-preview-publish.yml")
    platform_job = workflow["jobs"]["build-and-validate-platforms"]
    build_step = next(step for step in platform_job["steps"] if step.get("name") == "Build and push preview platform image")
    expected_output = "type=image,name=${{ needs.prepare.outputs.staging_image_name }},push-by-digest=true,name-canonical=true,push=true"
    assert build_step["with"]["outputs"] == expected_output

    cleanup_job = workflow["jobs"]["cleanup-staging-image"]
    assert cleanup_job["if"] == "${{ always() && needs.prepare.outputs.publication_state == 'build' }}"
    cleanup_step = next(step for step in cleanup_job["steps"] if step.get("name") == "Delete run-scoped staging index")
    assert "stage-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-index" in cleanup_step["run"]
    assert "amd64" not in cleanup_step["run"]
    assert "arm64" not in cleanup_step["run"]
    assert "cleanup_test_container_versions.py" in cleanup_step["run"]
    assert '--exact-staging-tag "$staging_tag"' in cleanup_step["run"]
    assert "--package-name sambee-staging" in cleanup_step["run"]
    assert "crane delete" not in cleanup_step["run"]
    assert cleanup_step["env"]["GITHUB_TOKEN"] == "${{ secrets.GITHUB_TOKEN }}"

    summary_job = workflow["jobs"]["summarize-candidate"]
    assert summary_job["if"] == "${{ always() }}"
    summary_step = summary_job["steps"][0]
    assert "GITHUB_STEP_SUMMARY" in summary_step["run"]
    for expected_detail in (
        "Canonical source tag",
        "Source SHA",
        "Final digest",
        "Docker version marker",
        "Staging reference",
        "Movable test tag",
    ):
        assert expected_detail in summary_step["run"]


def test_scheduled_cleanup_includes_the_isolated_staging_package() -> None:
    workflow = load_workflow("docker-image-cleanup.yml")
    assert workflow["concurrency"]["group"] == "docker-release-publication"
    cleanup_step = next(
        step for step in workflow["jobs"]["cleanup"]["steps"] if step.get("name") == "Delete unprotected and unreferenced package versions"
    )
    assert "--package-name sambee-staging" in cleanup_step["run"]
    assert "--allow-package-delete" in cleanup_step["run"]


def test_docker_backfill_does_not_sign_after_alias_promotion() -> None:
    workflow = load_workflow("docker-image-backfill.yml")
    assert "sign-and-attest" not in workflow["jobs"]


def test_companion_promotion_serializes_feed_updates_and_reports_push_targets() -> None:
    workflow = load_workflow("promote-companion-release.yml")
    assert workflow["concurrency"]["group"] == "companion-release-publication"
    assert workflow["concurrency"]["cancel-in-progress"] is False

    steps = workflow["jobs"]["promote"]["steps"]
    assert any(step.get("uses", "").startswith("actions/checkout@") for step in steps)
    promote_step = next(step for step in steps if step.get("name") == "Promote Companion release")
    assert promote_step["uses"] == "./.github/actions/promote-companion-release"
    assert promote_step["with"]["release-ref"] == "${{ inputs.release_ref }}"
    assert promote_step["with"]["release-repo-token"] == "${{ secrets.COMPANION_RELEASE_REPO_TOKEN }}"

    action = load_action("promote-companion-release")
    action_inputs = action["inputs"]
    assert action_inputs["release-repo-token"]["required"] is True
    assert action_inputs["release-ref"]["required"] is True

    action_steps = action["runs"]["steps"]
    resolve_step = next(step for step in action_steps if step.get("name") == "Resolve Companion release")
    assert "--resolve-release" in resolve_step["run"]
    assert resolve_step["env"]["RELEASE_REF"] == "${{ inputs.release-ref }}"
    assert resolve_step["env"]["GITHUB_TOKEN"] == "${{ inputs.release-repo-token }}"
    assert '"$RELEASE_REF"' in resolve_step["run"]

    provenance_step = next(step for step in action_steps if step.get("name") == "Validate Companion provenance")
    assert provenance_step["env"]["BUILD_TAG"] == "${{ steps.resolve.outputs.build_tag }}"
    assert provenance_step["env"]["SOURCE_SHA"] == "${{ steps.resolve.outputs.source_sha }}"
    assert "gh release download" not in provenance_step["run"]
    assert "sambee-release.json" not in provenance_step["run"]
    assert "validate_release_scope.py" not in provenance_step["run"]
    assert "sambee_release_tag" not in provenance_step["run"]

    generate_step = next(step for step in action_steps if step.get("name") == "Generate feed files")
    assert generate_step["env"]["RELEASE_ID"] == "${{ steps.resolve.outputs.release_id }}"
    assert generate_step["env"]["RELEASE_TAG"] == "${{ steps.resolve.outputs.release_tag }}"
    assert '--release-ref "$RELEASE_ID"' in generate_step["run"]
    assert '--expected-release-id "$RELEASE_ID"' in generate_step["run"]
    assert '--expected-release-tag "$RELEASE_TAG"' in generate_step["run"]

    push_step = next(step for step in action_steps if step.get("name") == "Commit and push feed updates")
    assert push_step["env"]["RELEASE_TAG"] == "${{ steps.resolve.outputs.release_tag }}"
    assert "gh release view" not in push_step["run"]
    assert "Failed to push feed updates for:" in push_step["run"]
    assert "remote feed state is unknown" in push_step["run"]

    action_run = "\n".join(step.get("run", "") for step in action_steps)
    assert "${{ inputs.release-ref }}" not in action_run


def test_companion_finalizer_recovers_exact_artifacts_and_uploads_completion_last() -> None:
    workflow = load_workflow("build-companion.yml")
    finalizer = workflow["jobs"]["finalize-release"]
    assert finalizer["needs"] == ["prepare", "build"]
    assert "recover-finalizer" in finalizer["if"]
    assert "needs.build.result == 'success'" in finalizer["if"]

    steps = finalizer["steps"]
    download_step = next(step for step in steps if step.get("name") == "Download authoritative Companion artifacts")
    assert "--recovery-provenance-output" in download_step["run"]
    assert "state=recover-finalizer" in download_step["run"]
    assert 'gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact_id"' in download_step["run"]
    assert ".expired" in download_step["run"]
    assert "expected_artifact_name" in download_step["run"]
    assert "origin_run_attempt" in download_step["run"]
    assert "companion-${origin_run_id}-${origin_run_attempt}" in download_step["run"]
    assert "artifact_id/zip" in download_step["run"]

    upload_step = next(step for step in steps if step.get("name") == "Upload verified release assets")
    run = upload_step["run"]
    assert "upload_or_verify" in run
    assert "remote_asset_name" in run
    assert "[^A-Za-z0-9._-]+" in run
    assert run.index("companion-release-manifest.json") < run.index("companion-release-provenance.json")
    assert run.rindex("companion-completion-marker.json") > run.index("while IFS= read")

    create_step = next(step for step in steps if step.get("name") == "Create or resume external draft release")
    assert "sambee-companion-recovery-v1" in create_step["run"]
    assert "release state changed after preflight" in create_step["run"]
    assert "resolve_companion_release_state.py" in create_step["run"]
    assert "created_draft=false" in create_step["run"]
    assert 'if [[ "$created_draft" != "true" ]]' in create_step["run"]

    verify_step = next(step for step in steps if step.get("name") == "Verify completed Companion draft")
    assert "promote_companion_release.py" in verify_step["run"]
    assert "--verify-only" in verify_step["run"]
    assert "--allow-draft" in verify_step["run"]


def test_companion_build_publishes_then_promotes_only_test_and_cleans_up() -> None:
    workflow = load_workflow("build-companion.yml")
    finalizer_steps = workflow["jobs"]["finalize-release"]["steps"]

    publish_step = next(step for step in finalizer_steps if step.get("name") == "Publish verified Companion release")
    assert 'gh api --method PATCH "repos/$RELEASE_REPOSITORY/releases/$release_id" -f draft=false' in publish_step["run"]
    assert "release_id_after_publish" in publish_step["run"]
    assert "release_tag_after_publish" in publish_step["run"]
    assert "published_at" in publish_step["run"]
    assert 'draft_after_publish="$(jq -r' in publish_step["run"]
    assert 'prerelease_after_publish="$(jq -r' in publish_step["run"]

    published_verify_step = next(step for step in finalizer_steps if step.get("name") == "Verify published Companion release")
    assert "--verify-only" in published_verify_step["run"]
    assert "--allow-draft" not in published_verify_step["run"]

    promote_test = workflow["jobs"]["promote-test"]
    assert promote_test["needs"] == ["prepare", "finalize-release"]
    assert "publication_state == 'complete'" in promote_test["if"]
    assert "needs.finalize-release.result == 'success'" in promote_test["if"]
    action_step = next(step for step in promote_test["steps"] if step.get("name") == "Promote Companion release to test")
    assert action_step["uses"] == "./.github/actions/promote-companion-release"
    assert action_step["with"]["companion-channel-test"] is True
    assert action_step["with"]["companion-channel-beta"] is False
    assert action_step["with"]["companion-channel-stable"] is False
    assert action_step["with"]["sambee"] is False

    cleanup = workflow["jobs"]["cleanup-releases"]
    assert cleanup["needs"] == "promote-test"
    assert cleanup["if"] == "${{ needs.promote-test.result == 'success' }}"
    cleanup_step = next(step for step in cleanup["steps"] if step.get("name") == "Delete obsolete Companion releases")
    assert "cleanup_companion_releases.py" in cleanup_step["run"]
    assert cleanup_step["env"]["GITHUB_TOKEN"] == "${{ secrets.COMPANION_RELEASE_REPO_TOKEN }}"


def test_companion_cleanup_workflow_and_manual_promotion_share_cleanup_contract() -> None:
    manual_promotion = load_workflow("promote-companion-release.yml")
    manual_cleanup = manual_promotion["jobs"]["cleanup-releases"]
    assert manual_cleanup["needs"] == "promote"
    assert manual_cleanup["if"] == "${{ needs.promote.result == 'success' }}"

    maintenance = load_workflow("cleanup-companion-releases.yml")
    assert maintenance["concurrency"]["group"] == "companion-release-publication"
    assert maintenance["concurrency"]["cancel-in-progress"] is False
    cleanup_step = next(
        step for step in maintenance["jobs"]["cleanup"]["steps"] if step.get("name") == "Delete obsolete Companion releases"
    )
    assert "cleanup_companion_releases.py" in cleanup_step["run"]
    assert cleanup_step["env"]["GITHUB_TOKEN"] == "${{ secrets.COMPANION_RELEASE_REPO_TOKEN }}"

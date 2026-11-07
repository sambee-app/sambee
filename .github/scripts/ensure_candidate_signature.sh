#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF' >&2
Usage: ensure_candidate_signature.sh \
  --image-ref <repository@sha256:digest> \
  --signature-repository <repository> \
  --github-repository <owner/repo>
EOF
  exit 1
}

image_ref=""
signature_repository=""
github_repository=""

readonly SIGNATURE_VERIFY_ATTEMPTS="${SIGNATURE_VERIFY_ATTEMPTS:-6}"
readonly SIGNATURE_VERIFY_RETRY_DELAY_SECONDS="${SIGNATURE_VERIFY_RETRY_DELAY_SECONDS:-2}"
readonly SIGNATURE_SIGN_ATTEMPTS="${SIGNATURE_SIGN_ATTEMPTS:-3}"
readonly SIGNATURE_SIGN_RETRY_DELAY_SECONDS="${SIGNATURE_SIGN_RETRY_DELAY_SECONDS:-15}"
readonly SIGNATURE_STORAGE_MODE="legacy"
readonly SIGSTORE_STATUS_URL="https://status.sigstore.dev/"
readonly PERMANENT_HTTP_STATUS_PATTERN='4(0[0-79]|1[0-9]|2[0-8]|[3-9][0-9])'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-ref) image_ref="$2"; shift 2 ;;
    --signature-repository) signature_repository="$2"; shift 2 ;;
    --github-repository) github_repository="$2"; shift 2 ;;
    *) usage ;;
  esac
done

if [[ -z "$image_ref" || -z "$signature_repository" || -z "$github_repository" || "$image_ref" != *@sha256:* ]]; then
  usage
fi

if ! [[ "$SIGNATURE_VERIFY_ATTEMPTS" =~ ^[1-9][0-9]*$ && "$SIGNATURE_VERIFY_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ &&
        "$SIGNATURE_SIGN_ATTEMPTS" =~ ^[1-9][0-9]*$ && "$SIGNATURE_SIGN_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Signature retry configuration must use positive attempts and non-negative whole-second delays." >&2
  usage
fi

expected_identity="https://github.com/$github_repository/.github/workflows/docker-image-preview-publish.yml@refs/heads/main"

verify_signature() {
  COSIGN_REPOSITORY="$signature_repository" cosign verify \
    --certificate-identity "$expected_identity" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    --new-bundle-format=false \
    "$image_ref" >/dev/null
}

verify_signature_after_signing() {
  local attempt
  for ((attempt = 1; attempt <= SIGNATURE_VERIFY_ATTEMPTS; attempt++)); do
    if verify_signature; then
      return 0
    fi
    if (( attempt < SIGNATURE_VERIFY_ATTEMPTS )); then
      echo "Candidate signature is not yet verified; retrying verification ($attempt/$SIGNATURE_VERIFY_ATTEMPTS)." >&2
      sleep "$SIGNATURE_VERIFY_RETRY_DELAY_SECONDS"
    fi
  done
  return 1
}

if verify_signature; then
  echo "Reused verified candidate signature for $image_ref"
  exit 0
fi

is_missing_signature_error() {
  grep -Eiq 'no signatures (found|associated)' "$1"
}

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
signature_output="$temp_dir/signature-output"
signature_error="$temp_dir/signature-error"
sign_output="$temp_dir/sign-output"
sign_error="$temp_dir/sign-error"

require_missing_signature() {
  if ! COSIGN_REPOSITORY="$signature_repository" cosign download signature "$image_ref" >"$signature_output" 2>"$signature_error"; then
    if is_missing_signature_error "$signature_error"; then
      : >"$signature_output"
    else
      echo "Unable to inspect existing signatures for $image_ref; refusing to sign. Check GHCR access and connectivity before rerunning failed jobs." >&2
      cat "$signature_error" >&2
      return 1
    fi
  fi

  if [[ -s "$signature_output" ]]; then
    echo "Existing signatures for $image_ref do not satisfy the required GitHub Actions identity policy; refusing to add another signature. Check the signature identity and verification errors." >&2
    return 1
  fi
}

is_retryable_signing_error() {
  if grep -Eiq 'unauthorized|forbidden|permission denied|access denied|invalid (token|identity|credential)|certificate.*(expired|invalid)|policy' "$sign_error"; then
    return 1
  fi
  if grep -Eiq "(^|[[:space:]:])(HTTP(/[0-9.]+)?[[:space:]]+|status([[:space:]]+code)?[[:space:]:=]+)$PERMANENT_HTTP_STATUS_PATTERN([^0-9]|$)|(^|[[:space:]:])$PERMANENT_HTTP_STATUS_PATTERN[[:space:]]+[[:alpha:]]" "$sign_error"; then
    return 1
  fi
  grep -Eiq 'giving up after [0-9]+ attempt\(s\)|timeout|timed out|deadline exceeded|connection (refused|reset)|unexpected EOF|TLS handshake timeout|temporary failure|service unavailable|too many requests|(^|[[:space:]:])(429|5[0-9]{2})([[:space:]:]|$)' "$sign_error"
}

require_missing_signature

for ((sign_attempt = 1; sign_attempt <= SIGNATURE_SIGN_ATTEMPTS; sign_attempt++)); do
  if (( sign_attempt > 1 )); then
    if verify_signature_after_signing; then
      echo "Reused verified candidate signature for $image_ref before signing retry"
      exit 0
    fi
    require_missing_signature
  fi

  echo "Signing candidate $image_ref (attempt $sign_attempt/$SIGNATURE_SIGN_ATTEMPTS)." >&2
  if COSIGN_REPOSITORY="$signature_repository" cosign sign \
    --new-bundle-format=false \
    --registry-referrers-mode "$SIGNATURE_STORAGE_MODE" \
    --use-signing-config=false \
    --yes "$image_ref" >"$sign_output" 2>"$sign_error"; then
    cat "$sign_output"
    cat "$sign_error" >&2
    if ! verify_signature_after_signing; then
      echo "Signing succeeded, but candidate signature for $image_ref did not satisfy the required GitHub Actions identity policy after $SIGNATURE_VERIFY_ATTEMPTS verification attempts. Check verification errors and GHCR connectivity; publication remains blocked." >&2
      exit 1
    fi
    echo "Published and verified candidate signature for $image_ref"
    exit 0
  fi

  cat "$sign_output"
  cat "$sign_error" >&2
  echo "Candidate signing failed (attempt $sign_attempt/$SIGNATURE_SIGN_ATTEMPTS)." >&2
  if ! is_retryable_signing_error; then
    echo "Signing error is not identified as temporary; refusing to retry. Check the Cosign errors above, OIDC permissions, credentials, and signing policy before rerunning failed jobs." >&2
    exit 1
  fi

  if verify_signature_after_signing; then
    echo "Reused verified candidate signature for $image_ref after signing reported a temporary failure"
    exit 0
  fi
  require_missing_signature

  if (( sign_attempt == SIGNATURE_SIGN_ATTEMPTS )); then
    echo "Candidate signing failed after $SIGNATURE_SIGN_ATTEMPTS attempts. Check $SIGSTORE_STATUS_URL and runner connectivity to Sigstore and GHCR. Rerun failed jobs after recovery if the staging image still exists; otherwise dispatch Release: Create Docker Image again for the same build version. Publication remains blocked." >&2
    exit 1
  fi
  retry_delay=$((10#$SIGNATURE_SIGN_RETRY_DELAY_SECONDS * sign_attempt))
  echo "Temporary signing failure; retrying in $retry_delay seconds after checking signature state." >&2
  sleep "$retry_delay"
done

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../deploy-course-v2.sh"

grep -Fqx 'RELEASE_COMMIT="${RELEASE_COMMIT:-}"' "$SCRIPT"
grep -Fq 'RELEASE_COMMIT must contain the full approved 40-character Git SHA.' "$SCRIPT"
grep -Fq 'current_commit="$(git rev-parse HEAD)"' "$SCRIPT"
grep -Fq '"$current_commit" != "$RELEASE_COMMIT"' "$SCRIPT"
! grep -Fq '16a426cbc38616f0ebb9400213bd04f0a282326c' "$SCRIPT"
grep -Fq 'ALLOW_UNBACKED_RELEASE' "$SCRIPT"
grep -Fq 'No backup was created because ALLOW_UNBACKED_RELEASE=1 was set.' "$SCRIPT"

echo "Course release commit guard tests passed."

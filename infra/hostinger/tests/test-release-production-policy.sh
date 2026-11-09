#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_SCRIPT="$SCRIPT_DIR/../release-production.sh"
READINESS_SCRIPT="$SCRIPT_DIR/../verify-production-readiness.sh"

grep -Fq 'ALLOW_UNBACKED_RELEASE="${ALLOW_UNBACKED_RELEASE:-0}"' "$RELEASE_SCRIPT"
grep -Fq 'ALLOW_UNBACKED_RELEASE must be either 0 or 1.' "$RELEASE_SCRIPT"
grep -Fq 'No new backup will be created because ALLOW_UNBACKED_RELEASE=1.' "$RELEASE_SCRIPT"
grep -Fq '"$SCRIPT_DIR/backup-data.sh"' "$RELEASE_SCRIPT"
grep -Fq '"$SCRIPT_DIR/verify-backup.sh" latest' "$RELEASE_SCRIPT"
grep -Fq 'ALLOW_UNBACKED_RELEASE="$ALLOW_UNBACKED_RELEASE"' "$RELEASE_SCRIPT"
grep -Fq 'Backup freshness verification was explicitly skipped for this release.' "$READINESS_SCRIPT"
grep -Fq 'elif "$SCRIPT_DIR/verify-backup.sh" latest' "$READINESS_SCRIPT"

backup_policy="$(sed -n '/if \[\[ "$ALLOW_UNBACKED_RELEASE" == "1" \]\]/,/^fi$/p' "$RELEASE_SCRIPT")"
grep -Fq 'else' <<< "$backup_policy"
grep -Fq 'backup-data.sh' <<< "$backup_policy"
grep -Fq 'verify-backup.sh' <<< "$backup_policy"

echo "Production release backup policy tests passed."

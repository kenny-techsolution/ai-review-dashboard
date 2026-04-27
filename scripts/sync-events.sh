#!/usr/bin/env bash
# Pull the latest reviewer events.jsonl artifacts from the source repo's
# GitHub Action runs, dedupe by PR id (newest run wins), and write them
# to data/events.jsonl. Run periodically to refresh the dashboard's data.
#
# Usage:
#   bash scripts/sync-events.sh
#
# Prerequisites:
#   - `gh` CLI authenticated (`gh auth status`)
#   - access to the SOURCE_REPO below
#
# Idempotent. Run as often as you like.

set -euo pipefail

SOURCE_REPO="${SOURCE_REPO:-kenny-techsolution/pos-lite}"
OUT_FILE="${OUT_FILE:-data/events.jsonl}"
TMP_DIR="$(mktemp -d)"

echo "Pulling reviewer-events artifacts from ${SOURCE_REPO}…"

# Get all reviewer-events-* artifacts, sorted by created_at desc
gh api "/repos/${SOURCE_REPO}/actions/artifacts" --paginate \
  -q '.artifacts[] | select(.name | startswith("reviewer-events-")) | "\(.id)\t\(.name)\t\(.created_at)"' \
  | sort -k2,2 -k3,3r \
  | awk -F'\t' '!seen[$2]++' \
  | while IFS=$'\t' read -r id name _; do
      echo "  · downloading ${name} (id=${id})…"
      curl -s -L -H "Authorization: token $(gh auth token)" \
        "https://api.github.com/repos/${SOURCE_REPO}/actions/artifacts/${id}/zip" \
        -o "${TMP_DIR}/${name}.zip"
      unzip -qo "${TMP_DIR}/${name}.zip" -d "${TMP_DIR}/${name}"
    done

# Concatenate all events.jsonl files in chronological order
mkdir -p "$(dirname "${OUT_FILE}")"
find "${TMP_DIR}" -name 'events.jsonl' -exec cat {} \; \
  | jq -s 'sort_by(.opened_at) | .[]' -c \
  > "${OUT_FILE}"

count=$(wc -l < "${OUT_FILE}" | tr -d ' ')
echo "Wrote ${count} events to ${OUT_FILE}"
echo "Cleaning up ${TMP_DIR}…"
rm -rf "${TMP_DIR}"
echo "Done. Commit and push to refresh the live dashboard."

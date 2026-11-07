#!/bin/sh
# Half of the verification for this task: the old symbol must be gone from
# EVERY file, not just the Python ones. Prefers ripgrep; falls back to grep so
# the check does not silently pass on a box without rg installed.
#
# This script excludes itself from the search on purpose -- it has to name the
# symbol it is hunting for, and it is listed immutable so that is not a hiding
# place.
set -e

needle='compute_surcharge'

if command -v rg >/dev/null 2>&1; then
  hits=$(rg --hidden --no-messages -n \
    --glob '!.git/**' --glob '!__pycache__/**' --glob '!.pytest_cache/**' \
    --glob '!check_rename.sh' \
    "$needle" . || true)
else
  hits=$(grep -rn --binary-files=without-match \
    --exclude-dir=.git --exclude-dir=__pycache__ --exclude-dir=.pytest_cache \
    --exclude=check_rename.sh \
    "$needle" . || true)
fi

if [ -n "$hits" ]; then
  echo "check_rename: '$needle' still present:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "check_rename: ok"

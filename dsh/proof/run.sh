#!/bin/zsh
# Reproduce the px-verify proof: one headless session against a fixture repo
# whose test suite cannot be made green, with the continuation cap set to 2.
#
# Costs three model calls: the first answer, then two forced continuations,
# then the cap yields. Touches nothing in $DSH_HOME except the headless profile
# directory dsh creates for itself on first use.
#
#   bash dsh/proof/run.sh
set -euo pipefail

FIXTURE=${FIXTURE:-/private/tmp/px-gate-proof}
HERE=${0:a:h}

export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use 22.23.2 >/dev/null 2>&1
set -a; . "$HOME/litellm/litellm.env"; set +a   # never echoed
export DSH_HOME="${DSH_HOME:-$HOME/dsh}"

# --- the fixture -----------------------------------------------------------
# package.json scripts.test + bun.lock, so resolveVerifyCommand INFERS
# `bun test` rather than being told. One passing test and one that asserts
# expect(1).toBe(2): red at baseline, and no code change can green it, which is
# what forces the cap rather than a fix.
rm -rf "$FIXTURE"
mkdir -p "$FIXTURE/src" "$FIXTURE/test"
cd "$FIXTURE"
print -r -- '{ "name": "px-gate-proof", "private": true, "type": "module", "scripts": { "test": "bun test" } }' > package.json
: > bun.lock
print -r -- 'export function add(a, b) {
  return a + b
}' > src/math.js
print -r -- "import { expect, test } from 'bun:test'
import { add } from '../src/math.js'

test('adds', () => {
  expect(add(2, 2)).toBe(4)
})

// False on purpose, and no code change can make it true. This is the unfixable
// red the continuation cap has to survive.
test('impossible', () => {
  expect(1).toBe(2)
})" > test/math.test.js
print -r -- 'This repository is a fixture. Keep answers to one short sentence.' > AGENTS.md
git init -q && git add -A && git -c user.email=proof@local -c user.name=proof commit -qm init

# --- the overlay -----------------------------------------------------------
# The SAME build the web profile has, plus a stderr log sink, with maxAttempts
# lowered to 2. Overlay patches are persisted nowhere.
PATCH="$FIXTURE/proof.patch.yml"
cat > "$PATCH" <<YAML
- insert:
    - id: px-log-stderr
      name: $HERE/../px-log-stderr/index.js
      config:
        level: 3
    - id: px-verify
      name: $DSH_HOME/profiles/web/px-verify/index.js
      config:
        maxAttempts: 2
        timeoutMs: 120000
        enabled: true
YAML

echo "=== free check: does the row compose? (no boot, no model call) ==="
npx -y @deepseek-ai/dsh@latest --profile headless --patch "$PATCH" --dump-config 2>/dev/null | tail -12

echo
echo "=== live: one headless session (3 model calls) ==="
npx -y @deepseek-ai/dsh@latest --profile headless --patch "$PATCH" \
  "Reply with the single word: done. Do not use any tools." \
  > "$FIXTURE/answer.txt" 2> "$FIXTURE/harness.log" || true

echo "--- the gate ---"
grep px-verify "$FIXTURE/harness.log" || echo "(no px-verify lines: the plugin did not load)"
echo
echo "--- what the model finally said ---"
cat "$FIXTURE/answer.txt"

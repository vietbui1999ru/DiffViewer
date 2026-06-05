#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $1"; exit 1; }

TMP="$(mktemp -d)"
export CLAUDE_SETTINGS="$TMP/settings.json"
PTU='~/.claude/tools/diff-viewer/hooks/post-tool-use.sh'

# AC-I3 scaffold from absent
./scripts/install.sh >/dev/null
[ -f "$CLAUDE_SETTINGS" ] || fail "I3 settings.json not created"

# AC-I1/I5 entries present, correct matcher
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.env.CLAUDE_SETTINGS, "utf8"));
  const ptu = c.PostToolUse.find(e => (e.hooks||[]).some(h => h.command.includes("post-tool-use.sh")));
  if (!ptu) process.exit(1);
  if (ptu.matcher !== "Write|Edit|MultiEdit") process.exit(2);
  if (!c.Stop.some(e => (e.hooks||[]).some(h => h.command.includes("stop.sh")))) process.exit(3);
' || fail "I1/I5 entries missing or wrong matcher"

# AC-I4 ~/-relative path
grep -q "$PTU" "$CLAUDE_SETTINGS" || fail "I4 path not ~/-relative"

# AC-I2/I6 idempotent: second run, no duplicates, exit 0
./scripts/install.sh >/dev/null || fail "I6 second run nonzero exit"
COUNT="$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.env.CLAUDE_SETTINGS, "utf8"));
  const n = c.PostToolUse.filter(e => (e.hooks||[]).some(h => h.command.includes("post-tool-use.sh"))).length;
  console.log(n);
')"
[ "$COUNT" = "1" ] || fail "I2 duplicate PostToolUse entry (count=$COUNT)"

# coexistence: pre-existing unrelated hook survives
echo '{"PostToolUse":[{"matcher":"Write|Edit|MultiEdit","hooks":[{"type":"command","command":"~/.claude/hooks/lint-on-write.sh"}]}]}' > "$CLAUDE_SETTINGS"
./scripts/install.sh >/dev/null
grep -q 'lint-on-write.sh' "$CLAUDE_SETTINGS" || fail "I1 clobbered existing hook"

rm -rf "$TMP"
echo "PASS: install"

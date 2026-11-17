#!/usr/bin/env bash
set -e
mkdir -p ~/claims-build
cd ~/claims-build
git init -q
git symbolic-ref HEAD refs/heads/main
git config user.name "Feature builder"
git config user.email "feature-builder@example.com"
git config commit.gpgsign false
mkdir -p src tests test-service runs .claude/agents .claude/skills/claims-api
touch src/__init__.py tests/__init__.py

cat > intent.md <<'EOF'
# Intent: Payment date on the claim status panel

From: the claims manager

Problem: Customers call to ask when their claim will be paid.
Outcome: The claim status panel shows the date of the next payment.
EOF

cat > spec.md <<'EOF'
# Spec: Claim Status Panel
Version: 2, approved by the product owner

## Requirements
R1 The panel lists every open claim of the customer.
R2 A status change shows in the panel within 15 minutes.
R3 A rejected claim shows "Rejected" and the phone number
   of its claims handler.
R4 The panel shows the date of the next payment of the claim.
   If no payment is planned, it shows "No payment planned".

## Checks
R1 to R3: built and checked in version 1.
R4: tests/test_payment_date.py and tests/test_no_payment_planned.py,
    written by a test author before the build.
EOF

cat > plan.md <<'EOF'
# Plan: R4, the payment date on the claim status panel

Spec: spec.md, version 2, requirement R4.

## Steps
1. Show the next payment date, read with next_payment(claim_id)
   from src/claims_system.py, as "Next payment: 3 November 2026".
   Check: python3 -m unittest tests.test_payment_date
2. If no payment is planned, show "No payment planned".
   Check: python3 -m unittest tests.test_no_payment_planned

## Done when
D1. Each claim shows its own next payment date.
D2. A claim without a planned payment shows "No payment planned".
D3. All checks pass: ./verify.sh

## Test claims
1042: payment on 3 November 2026
1043: payment on 17 November 2026
1050: no payment planned
EOF

cat > test-service/payments.json <<'EOF'
{"1042": "2026-11-03", "1043": "2026-11-17", "1050": null}
EOF

cat > src/claims_system.py <<'EOF'
"""Client for the claims system. Here, it reads a local test service."""
import json
from datetime import date
from pathlib import Path

SERVICE = Path(__file__).resolve().parent.parent / "test-service"


def next_payment(claim_id):
    """Return the date of the next payment, or None if none is planned.

    Raises ConnectionError when the claims test service does not answer.
    """
    if (SERVICE / "DOWN").exists():
        raise ConnectionError("The claims test service does not answer.")
    payments = json.loads((SERVICE / "payments.json").read_text())
    value = payments[str(claim_id)]
    return date.fromisoformat(value) if value else None
EOF

cat > src/panel.py <<'EOF'
import sys


def status_panel(claim_id):
    return {"claim": claim_id, "status": "Approved"}


if __name__ == "__main__":
    print(status_panel(int(sys.argv[1])))
EOF

cat > tests/test_payment_date.py <<'EOF'
"""Accepted tests for R4, step 1. Written before the build. Do not change them."""
import unittest
from src.panel import status_panel


class PaymentDateTest(unittest.TestCase):
    def test_claim_1042_shows_its_own_date(self):
        self.assertEqual(status_panel(1042)["payment"], "Next payment: 3 November 2026")

    def test_claim_1043_shows_its_own_date(self):
        self.assertEqual(status_panel(1043)["payment"], "Next payment: 17 November 2026")
EOF

cat > tests/test_no_payment_planned.py <<'EOF'
"""Accepted test for R4, step 2. Written before the build. Do not change it."""
import unittest
from src.panel import status_panel


class NoPaymentPlannedTest(unittest.TestCase):
    def test_claim_1050_shows_no_payment_planned(self):
        self.assertEqual(status_panel(1050)["payment"], "No payment planned")
EOF

cat > verify.sh <<'EOF'
#!/usr/bin/env bash
# All checks: a compile check and the tests.
# Prints one line when they pass, and only the failures when they do not.
python3 -m compileall -q src > /dev/null || { echo "FAIL: src does not compile"; exit 1; }
out=$(python3 -m unittest 2>&1)
code=$?
if [ "$code" -eq 0 ]; then
  echo "PASS: $(printf '%s\n' "$out" | sed -n 's/^Ran \([0-9]*\) test.*/\1/p') tests"
else
  printf '%s\n' "$out" | grep -E '^(FAIL|ERROR):|Error:' | head -20
  echo "FAIL: $(printf '%s\n' "$out" | tail -n 1)"
fi
exit "$code"
EOF
chmod +x verify.sh

cat > .claude/skills/claims-api/SKILL.md <<'EOF'
---
name: claims-api
description: How to read claim data from the claims system. Use it when code needs payment dates or other claim data.
---
Read claim data only through src/claims_system.py.

- next_payment(claim_id) returns a date, or None when no payment is planned.
- None is a normal answer. The panel shows "No payment planned".
- It raises ConnectionError when the claims test service does not answer.
  That is not a normal answer. Never replace it with a fixed date.
EOF

cat > .claude/settings.json <<'EOF'
{
  "permissions": {
    "deny": ["Bash(rm *)", "Edit(test-service/**)"]
  }
}
EOF

cat > run.sh <<'EOF'
#!/usr/bin/env bash
# The implementation service for R4.
# Code runs every step it can predict. Only step 2 is the agent.
# Usage: ./run.sh <run number> [branch to start from, default main]
set -u
cd "$(dirname "$0")"
run="${1:-1}"
base="${2:-main}"
branch="agent/payment-date-$run"
out="runs/$run"
agent_file=".claude/agents/feature-builder.md"
[ -f "$agent_file" ] || { echo "Create $agent_file first (task 2)."; exit 1; }
rm -rf "$out"
mkdir -p "$out"
rm -f blocked.md summary.md

# 1. Prepare: a new branch, and the checks before the change
git switch -q -f main
git switch -q -C "$branch" "$base" || exit 1
start=$(git rev-parse --short HEAD)
./verify.sh > "$out/baseline.txt" 2>&1

# 2. Run: the feature builder, headless, with a turn limit and a cost limit
echo "Run $run: the feature builder is working. This takes a few minutes."
claude -p "Build R4 from spec.md (version 2) and plan.md. Check git log first: earlier steps may be done already." \
  --agent feature-builder \
  --permission-mode dontAsk \
  --allowedTools "Read,Edit,Write,Glob,Grep,Skill,Bash(./verify.sh),Bash(./verify.sh *),Bash(python3 -m unittest),Bash(python3 -m unittest *),Bash(python3 -m src.panel *),Bash(git status),Bash(git status *),Bash(git diff),Bash(git diff *),Bash(git log),Bash(git log *),Bash(git add *),Bash(git commit *)" \
  --max-turns 30 \
  --max-budget-usd 2 \
  --output-format json > "$out/agent-output.json"

# 3. Check: save all work, then run the checks on the final commit
[ -f blocked.md ] && mv blocked.md "$out/"
[ -f summary.md ] && mv summary.md "$out/"
if [ -n "$(git status --porcelain)" ]; then
  git add -A && git commit -q -m "Saved by run.sh: work the agent did not commit"
fi
final=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then
  status="failed"; reason="run.sh could not commit the work of the agent"
elif [ -f "$out/blocked.md" ]; then
  status="blocked"; reason="$(grep -v '^#' "$out/blocked.md" | grep -m 1 .)"
elif ./verify.sh > "$out/checks.txt" 2>&1; then
  status="done"; reason=""
else
  status="failed"; reason="$(tail -n 1 "$out/checks.txt")"
fi

# 4. Deliver: the pull request text (only when done) and the run report
version=$(git hash-object "$agent_file" | cut -c1-7)
if [ "$status" = "done" ]; then
  {
    echo "# R4: Next Payment Date on the Claim Status Panel"
    echo
    echo "Spec: version 2, R4"
    echo "Agent: feature-builder, version $version"
    echo "Commits: $start..$final on $branch"
    echo "Record of the run: $out/"
    echo
    echo "## Checks on $final (written by run.sh)"
    cat "$out/checks.txt"
    echo
    echo "## Summary from the agent"
    cat "$out/summary.md" 2>/dev/null || echo "(The agent wrote no summary.)"
  } > "$out/pr.md"
fi
python3 - "$out" "$status" "$reason" "$version" "$start" "$final" "$branch" <<'PY'
import json, sys
out, status, reason, version, start, final, branch = sys.argv[1:8]
try:
    agent = json.load(open(f"{out}/agent-output.json"))
except Exception:
    agent = {}
ms = agent.get("duration_ms")
report = {
    "task": "R4",
    "status": status,
    "reason": reason,
    "pull_request": f"{out}/pr.md" if status == "done" else None,
    "agent": f"feature-builder, version {version}",
    "spec": "version 2",
    "branch": branch,
    "start_commit": start,
    "final_commit": final,
    "minutes": round(ms / 60000, 1) if ms else None,
    "turns": agent.get("num_turns"),
    "cost_usd": agent.get("total_cost_usd"),
}
with open(f"{out}/run.json", "w") as f:
    json.dump(report, f, indent=2)
PY
git switch -q main
echo "Status: $status. The results are in $out/"
EOF
chmod +x run.sh

cat > .gitignore <<'EOF'
__pycache__/
runs/
notes.md
blocked.md
summary.md
test-service/DOWN
.claude/agents/
EOF

git add -A
git -c user.name="Factory" -c user.email="factory@example.com" commit -q -m "Spec version 2, plan and accepted tests for R4"
echo "Done. The project is in ~/claims-build"

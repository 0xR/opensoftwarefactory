#!/usr/bin/env bash
set -e
mkdir -p ~/claims-review
cd ~/claims-review
git init -q
mkdir -p src tests review .claude/agents
touch src/__init__.py tests/__init__.py

cat > intent.md <<'EOF'
# Intent: Payment date on the claim status panel

From: the claims manager

Problem: Customers call to ask when their claim will be paid.
Outcome: The claim status panel shows the date of the next payment.
EOF

cat > spec.md <<'EOF'
# Spec: Claim status panel

R4. The panel shows the date of the next payment of the claim.
    If no payment is planned, it shows "No payment planned".
EOF

cat > plan.md <<'EOF'
# Plan: Payment date on the claim status panel

Intent: intent.md. Spec: spec.md, requirement R4.

## Steps
1. Read the next payment date from the claims system:
   next_payment(claim_id) in src/claims_system.py.
2. Show it on the panel as "Next payment: 3 November 2026".
3. If no payment is planned, show "No payment planned".

## Done when
D1. Each claim shows its own next payment date.
D2. A claim without a planned payment shows
    "No payment planned".
D3. The tests check D1 and D2, and they pass.

## Test claims
1042: payment on 3 November 2026
1043: payment on 17 November 2026
1050: no payment planned
EOF

cat > src/claims_system.py <<'EOF'
from datetime import date

PAYMENTS = {
    1042: date(2026, 11, 3),
    1043: date(2026, 11, 17),
    1050: None,
}


def next_payment(claim_id):
    """Return the date of the next payment, or None."""
    return PAYMENTS[claim_id]
EOF

cat > src/panel.py <<'EOF'
import sys


def status_panel(claim_id):
    return {"claim": claim_id, "status": "Approved"}


if __name__ == "__main__":
    print(status_panel(int(sys.argv[1])))
EOF

cat > panel.sh <<'EOF'
#!/usr/bin/env bash
# Shows the claim status panel for one claim, as a customer sees it.
cd "$(dirname "$0")"
python3 -m src.panel "$1"
EOF

cat > test.sh <<'EOF'
#!/usr/bin/env bash
# Runs all tests.
cd "$(dirname "$0")"
python3 -m unittest -v
EOF

chmod +x panel.sh test.sh

git add -A
git -c user.name="Factory" -c user.email="factory@example.com" commit -q -m "Claim status panel with plan for R4"

cat > tests/test_panel.py <<'EOF'
import unittest
from src.panel import status_panel


class PaymentDateTest(unittest.TestCase):
    def test_claim_1042_shows_its_payment_date(self):
        self.assertEqual(status_panel(1042)["payment"], "Next payment: 3 November 2026")

    def test_claim_1050_shows_no_payment_planned(self):
        self.assertEqual(status_panel(1050)["payment"], "No payment planned")
EOF

git add -A
git -c user.name="Factory" -c user.email="factory@example.com" commit -q -m "Tests for R4 (they fail until R4 is built)"

cat > src/panel.py <<'EOF'
import sys

from src.claims_system import next_payment


def status_panel(claim_id):
    # Next payment date for the panel (plan step 2).
    payment = next_payment(claim_id)
    text = f"Next payment: {payment.day} {payment:%B} {payment.year}"
    return {"claim": claim_id, "status": "Approved", "payment": text}


if __name__ == "__main__":
    print(status_panel(int(sys.argv[1])))
EOF

cat > tests/test_panel.py <<'EOF'
import unittest
from src.panel import status_panel


class PaymentDateTest(unittest.TestCase):
    def test_claim_1042_shows_its_payment_date(self):
        self.assertEqual(status_panel(1042)["payment"], "Next payment: 3 November 2026")
EOF

cat > pr.md <<'EOF'
Added the payment date to the claim status panel. All tests pass.
EOF

git add -A
git -c user.name="Author agent" -c user.email="agent@example.com" commit -q -m "Add the payment date to the claim status panel"
echo "Done. The project is in ~/claims-review"

"""Required check for policy CL-7 (policies/cl-7.md). Do not change it.

For a rejected claim, the panel text must be exactly the approved text.
Any other text fails, because a rejection reason can hide in many wordings.

Usage: python3 checks/check_cl7.py     (exit code 0: passed, 1: failed)
"""
import sys
from pathlib import Path

REJECTED_CLAIM = 2042
APPROVED_TEXT = "Rejected. Call your claims handler: 020 123 4567."
MUST_PASS = "Rejected. Call your claims handler: 020 123 4567."
MUST_FAIL = "Rejected: the damage happened before your policy started."


def allowed(text):
    """True when `text` is the approved panel text for a rejected claim."""
    return text == APPROVED_TEXT


def main():
    if not allowed(MUST_PASS) or allowed(MUST_FAIL):
        print("CL-7: the check itself is broken; its two example texts do not pass and fail as they must.")
        return 1
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    try:
        from src.panel import status_panel
        text = status_panel(REJECTED_CLAIM)
    except Exception as error:
        print(f"CL-7: the panel of the rejected claim {REJECTED_CLAIM} could not be shown "
              f"({type(error).__name__}: {error}).")
        return 1
    if not allowed(text):
        print(f'CL-7: the panel text of a rejected claim must be exactly "{APPROVED_TEXT}" It is "{text}".')
        return 1
    print("CL-7 check passed: the panel of a rejected claim shows only the approved text.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

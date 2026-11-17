import sys

from src.claims_system import get_claim


def status_panel(claim_id):
    """Return the text of the status box that the customer sees for one claim."""
    claim = get_claim(claim_id)
    if claim["status"] == "Rejected":
        return ""
    return claim["status"] + "."


if __name__ == "__main__":
    print(status_panel(int(sys.argv[1])))

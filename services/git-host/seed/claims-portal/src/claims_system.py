"""Client for the claims system. Here, it holds three test claims."""

CLAIMS = {
    2041: {"status": "Approved"},
    2042: {
        "status": "Rejected",
        "handler_phone": "020 123 4567",
        "rejection_reason": "The damage happened before your policy started.",
    },
    2043: {"status": "In review"},
}


def get_claim(claim_id):
    """Return the record of one claim."""
    return CLAIMS[claim_id]

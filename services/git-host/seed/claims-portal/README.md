# Claims portal (Session 7: guardrails for CL-7)

A small project for the guardrail exercise. It holds the claim status panel after the
incident: for a rejected claim, the status box is empty.

| File | Content |
| --- | --- |
| `incident.md` | The incident ticket: what to fix. |
| `policies/cl-7.md` | Policy CL-7: only a claims handler tells a customer why a claim was rejected. |
| `src/panel.py` | `status_panel(claim_id)`: the text of the status box. |
| `src/claims_system.py` | The claim records, with the rejection reason and the phone number of the claims handler. |
| `checks/check_cl7.py` | The required check for CL-7: the panel text of a rejected claim must be exactly the approved text. |
| `handover.sh` | The handover: runs the check and prints "Accepted" or "Rejected: <reason>". |
| `panel.sh` | Shows the panel of one claim: `./panel.sh 2042`. |
| `AGENTS.md` | Guidance for agents that work in this project. |

## Try it

```bash
./panel.sh 2042      # the rejected claim: an empty line (the incident)
./handover.sh        # Rejected: CL-7: the panel text of a rejected claim must be exactly ...
```

The handover accepts the panel when `status_panel(2042)` returns exactly:

```
Rejected. Call your claims handler: 020 123 4567.
```

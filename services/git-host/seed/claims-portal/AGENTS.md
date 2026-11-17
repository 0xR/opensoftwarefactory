# Claims portal: guidance for agents

This project is the claim status panel of the claims portal.

- The panel code is `src/panel.py`. `status_panel(claim_id)` returns the text of the status
  box that the customer sees. The claim records come from `src/claims_system.py`.
- Show the panel of one claim with `./panel.sh <claim>`. The test claims are 2041 (approved),
  2042 (rejected) and 2043 (in review).
- Before you hand over, run `./handover.sh`. It prints "Accepted" or "Rejected: <reason>".
  Only an accepted result goes on.
- Do not change `checks/`, `handover.sh` or `policies/`. They are protected.
- When a tool call is blocked, read the message: it names the rule, the reason and the fix.
  Make the change that the message asks for. Do not try another way around the block.
- Commit your change with `git add` and `git commit`.

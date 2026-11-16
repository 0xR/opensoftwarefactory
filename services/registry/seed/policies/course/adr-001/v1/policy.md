# ADR-001: The portal reaches claim data only through the claims API

Status: accepted. Owner: the tech lead. Application: the customer portal of an insurer (an imaginary application for this course).

## Decision

Every portal feature reads and writes claim data only through the claims API of the claims system.

## Reason

The claims system is slow and belongs to another team. Direct access to its database skips its access rules, breaks when its tables change, and can overload it.

## Rules that follow

- A1: No portal component reads or writes the claims database directly.
- A2: The portal sends at most 5 requests per second to the claims API. A spec for a feature that calls the claims API states how it stays within this limit.
- A3: The portal may keep claim data in its cache for at most 15 minutes. A spec that caches claim data states the cache time.
- A4: Every call to the claims API has a timeout. A spec states what the customer sees when the claims API does not answer.
- A5: No new database, message system or external service without a new ADR.
- A6: A customer sees only their own claims. The portal passes the customer ID from the portal login to the claims API and never takes it from the request.

## Not allowed

- A copy of the claims tables in a portal database.
- Calls from the browser straight to the claims system.

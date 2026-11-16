# How a spec describes architecture

Owner: the tech lead.

## A spec must

- S1: Have a section `Architecture`.
- S2: Name every system the feature touches.
- S3: Say for each system how the feature talks to it: API call, event or file.
- S4: List the ADRs that apply, by ID.
- S5: Say which data the feature stores, where, and for how long. "Stores nothing" is a valid answer.
- S6: Say what the user sees when a system the feature needs does not answer.
- S7: Give a number for every limit it relies on, such as requests per second or cache time.

## A spec must not

- S8: Choose a new database, message system or external service. That needs an ADR first.
- S9: Contradict an ADR, even when a requirement seems to need it. It adds a concern with the tech lead as owner instead.
- S10: Leave an architecture choice open without naming who decides it.

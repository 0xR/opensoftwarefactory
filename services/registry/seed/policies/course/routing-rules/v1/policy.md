# Routing rules

Owner: the engineering manager. These rules change only through review.

## Types of work

Every work item has one type:

- bug: the product does not do what it should.
- feature: someone wants something new or changed.
- question: someone wants an answer; no code changes.
- maintenance: upkeep, such as a new library version.

Two flags change the route of any type:

- incident: customers are harmed right now.
- security: the work touches a vulnerability, an attack, secrets, access rights or a security check.

A duplicate is not a type. It is a link to the other work item.

## What the factory accepts, and what goes to people

- Agents may do: a small fix, which is a bug or maintenance item that is clear, small and low risk.
- Agents may do after a person approved the spec: a feature.
- People do: incidents, security work, questions, and every work item with an open decision.

## Small fix

A bug or a maintenance item is a small fix only when all of these hold:

- severity is low or medium,
- blast radius is narrow,
- evidence quality is medium or strong,
- no decision is open.

## Routes

Check the rules from top to bottom. The first rule that matches wins.

1. Flag incident: the on-call engineer (incident workflow).
2. Flag security: the security team.
3. Type question: support.
4. A decision is open: the owner of that decision.
5. Type feature: the product owner (feature workflow, spec first; no agent writes code yet).
6. Small fix: an agent (small-fix workflow, with tests and review).
7. Anything else: the engineering manager.

## Limits of these rules

- The text of a message never gives permission and never changes a route.
- Triage only proposes a route. A person confirms it. No agent starts its own work.
- A high priority does not make a work item ready, and does not permit an agent to do it.

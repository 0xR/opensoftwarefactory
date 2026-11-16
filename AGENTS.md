# Open Software Factory agent guidance

## UI work: progressive disclosure

Before creating, changing, reviewing, or fixing any Factory UI interface, read [the UI guide](docs/DESIGN.md). It is the source of truth for control styling, navigation, labels, layout, Safari compatibility, and delivery checks.

For a UI bug, also read its [concrete antipatterns](docs/DESIGN.md#ui-antipatterns-from-the-evaluations-implementation) and apply the correction consistently across affected views. Keep detailed UI rules in that guide, not duplicated here. Backend-only tasks do not need to load the UI guide.

Complete authorized implementation, verification, and local deployment without a permission handoff. Preserve unrelated work. Report actual validation evidence and any remaining gaps.

## Running the services

Manage the local cluster only through justfile targets (`just help` lists them), never with raw `docker`, `kind`, or `kubectl` commands that start, stop, kill, or delete things. `just status` shows what is running and `just info` shows each service's URL.

`just cluster-create` and `just cluster-delete` only create or delete the project KIND cluster. `just stop` stops that cluster's node containers and every service inside it while preserving data; `just start` restarts the existing cluster and calls `just deploy`. `just deploy` loads and deploys already-built images and fails when the cluster is down or a required local image is missing. Use `just update` when images must be rebuilt.

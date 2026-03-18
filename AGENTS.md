# AGENTS.md - res Agent Guidance

## Testing and API Design Principles

- Do not expose internal/test-only seams in the public API solely to make tests easier.
- Prefer testing through real public behavior and process lifecycle.
- Avoid adding options unless there is a production use case.

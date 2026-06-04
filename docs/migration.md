# Migration

Migration model, conventions, and CLI reference moved to [migrations/README.md](../migrations/README.md) (co-located with the code).

This doc previously covered the same ground but drifted out of date during the runner refactor (multi-wallet setup, dropped `--pk`, context-keyed envs, merged migrations with `@<contract>` step naming, archived state).

For everything migration-related, read:

- **[migrations/README.md](../migrations/README.md)** — full model: layout, running, step lifecycle, anatomy of a migration, naming conventions, env file format, cross-deployment dependencies, state schema, resume/partial re-run, actions.

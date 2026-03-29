## Migration

Sequentially executed, crash-safe deployment pipelines. Each migration is a folder containing a config (`index.ts`) and numbered step files (`NNN-*.ts`) that are auto-discovered and run in order.

### Structure

```
migrations/
  runner.ts              # Execution engine
  run.ts                 # CLI entry point
  types.ts               # Shared type definitions
  actions/               # Reusable action functions
  definitions/           # Migration definitions
  envs/                  # Per-migration env files
```

### How it works

1. **Env loading** — Runner loads `migrations/envs/{migration}.{env}.env`. Shell variables take precedence over file values.
2. **Setup** — Each migration's `index.ts` exports a `setup` function that reads env vars and creates a wallet context.
3. **Step discovery** — Files matching `NNN-*.ts` are sorted and executed sequentially.
4. **State persistence** — After each step, state is saved to `deployments/{env}/{migration}.json`. On re-run, completed steps are skipped.
5. **Output passing** — Each step returns a `Record<string, string>`. Subsequent steps access prior outputs via `ctx.outputs["step-name"].field`.

### Usage

From the platform directory (e.g. `platforms/evm`):

```bash
npx tsx migrations/run.ts -- \
  --migration oracle-relay \
  --env fork \
  --pk your_private_key
```

| Flag          | Description                                    |
| ------------- | ---------------------------------------------- |
| `--migration` | Migration name (folder under `definitions/`)   |
| `--env`       | Environment name (`moon`, `fork`, `base`, etc) |
| `--pk`        | Private key used to sign transactions          |
| `--from`      | Reset and re-run from this step onward         |
| `--pause-at`  | Pause after this step (inclusive)              |

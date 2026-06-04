# Migrations

Sequentially-executed, crash-safe deployment pipelines. Each **migration** is a self-contained folder that deploys + configures a complete feature end-to-end (across however many chains the feature spans) and ends with ownership being transferred or renounced. Once a migration completes, its state file is the audit record of what got deployed.

Used for: every prod deployment and every fork dry-run.

## Layout

```
migrations/
  run.ts                              # CLI entry — delegates to @whm/common/migration
  README.md                           # this file
  definitions/<migration>/            # one per deployable feature
    types.ts                          # WalletContext + narrowed step types
    index.ts                          # config: name, pks, setup() builds wallets
    NNN-<verb>-<target>[@<contract>].ts   # ordered atomic steps
  actions/<contract-or-feature>/      # reusable atomic operations (deploy/setOwner/…)
  envs/<context>/<migration>.env      # per (env-context, migration) config
```

State files live outside this dir, in `deployments/<context>/<migration>.json` — one JSON per (env-context, migration) pair.

## Running

From the repo root:

```bash
PK_LANDING=0x... PK_PROXY=0x... PK=0x... \
  npx tsx migrations/run.ts --migration basejump-base --env prod
```

Or via the sh wrapper:

```bash
bash sh/migrate-basejump-base.sh prod
```

Or via the root npm script:

```bash
pnpm migrate:basejump-base
```

| Flag          | Required | Description                                             |
| ------------- | -------- | ------------------------------------------------------- |
| `--migration` | yes      | Folder name under `definitions/` (e.g. `basejump-base`) |
| `--env`       | yes      | Context name under `envs/` (`prod`, `fork`)             |
| `--from`      | no       | Reset and re-run from this step onward                  |
| `--pause-at`  | no       | Stop after completing this step (inclusive)             |

PKs are **not** CLI flags. Each migration declares the env vars it needs in its `index.ts` `pks: [...]`; the runner reads them from `process.env` and validates presence before invoking `setup()`.

## How a step runs

1. **Env file loaded.** Runner reads `migrations/envs/<env>/<migration>.env` into `process.env`. Shell vars take precedence (so secrets in a root `.env` or shell override checked-in templates).
2. **PKs validated.** Every name in the migration's `pks: string[]` must be present in `process.env`.
3. **Setup builds wallets.** The migration's `setup(env)` returns a `WalletContext` map — typically `{ hydration, moonbeam, base }` or whatever chains the migration touches.
4. **State loaded or created.** If `deployments/<env>/<migration>.json` exists, completed steps are skipped (resume). Otherwise a fresh state is created.
5. **Steps execute sequentially.** Each `NNN-*.ts` exports a `MigrationStep` with `action(ctx)`. The action picks the relevant wallet (`ctx.wallet.moonbeam`, etc.), reads any needed env vars (`ctx.env.WORMHOLE_CORE_MOONBEAM`), reads previous step outputs (`ctx.outputs["003-deploy-transactor"].proxyAddress`), and returns a `StepOutput` (flat key/value record).
6. **State saved after each step.** Crash-safe: re-running picks up exactly where it failed.

## Step naming convention

Files are `NNN-<verb>-<subject>[@<contract>].ts` where `NNN` is a zero-padded order index. The `@<contract>` suffix names the contract the action operates on. Phases group naturally by NNN order:

1. **Deploys** — `001-deploy-<contract>.ts`. Always first; no `@` (the deploy IS the contract).
2. **Authorize** — `NNN-authorize-<subject>@<contract>.ts`. Granting permissions. E.g. `005-authorize-proxy@transactor`.
3. **Wire (cross-contract addresses)** — `NNN-set-<thing>@<contract>.ts`. Storing one contract's address on another. E.g. `007-set-transactor@proxy`.
4. **Config (per-asset / per-feature)** — `NNN-set-<asset>-<thing>@<contract>.ts` or `NNN-register-<thing>@<contract>.ts`. E.g. `012-set-eurc-fee@basejump`, `004-register-prime@emitter`.
5. **Ownership** — `NNN-transfer-ownership@<contract>.ts` (transfer to a custodian) or `NNN-renounce@<contract>.ts` (transfer to `0x0`). Always last.

`@<contract>` reads naturally: "set X on Y", "authorize X on Y", "renounce Y". File listings stay readable; reordering only requires renumbering.

## Env file format

```ini
# migrations/envs/prod/basejump-base.env

# === Base ===
RPC_BASE=https://mainnet.base.org
CHAIN_ID_BASE=8453
WORMHOLE_ID_BASE=30
WORMHOLE_CORE_BASE=0x...
TOKEN_BRIDGE_BASE=0x...

# === Moonbeam ===
RPC_MOONBEAM=...
...

# === Asset config ===
EURC_SOURCE_ASSET=0x...
EURC_DEST_ASSET=0x...

# === Ownership renunciation targets ===
LANDING_NEW_OWNER=0x...
PROXY_NEW_OWNER=0x...
BASEJUMP_NEW_OWNER=0x...
```

Conventions:

- Chain-prefixed vars: `RPC_<CHAIN>`, `CHAIN_ID_<CHAIN>`, `WORMHOLE_CORE_<CHAIN>`, `TOKEN_BRIDGE_<CHAIN>`.
- Single-chain values (Moonbeam-only XcmTransactor config): unprefixed (`DESTINATION_PARA_ID`, `FEE_ASSET`, etc.).
- Asset-prefixed vars: `<ASSET>_<thing>` (e.g. `EURC_FEE_ASSET`, `PRIME_ASSET_ID_BYTES32`).
- Ownership: `<contract>_NEW_OWNER`.
- **PKs are NOT in env files.** They live in shell env or root `.env` (gitignored). The migration's `pks: [...]` declares which it needs.

## Cross-deployment dependencies — by env config, not by `ctx.ref`

There is no cross-migration runtime ref. If migration B needs an address from migration A's deployment, the operator copies the address from `deployments/<env>/A.json` into `envs/<env>/B.env` as a config variable. B's step reads it as `ctx.env.SOME_ADDRESS`.

This makes every dependency explicit + auditable. State files are write-once records, never queried at runtime by other migrations.

## Adding a new migration

1. `mkdir migrations/definitions/<your-migration>`
2. Create `types.ts` (define `WalletContext` map for the chains your migration touches)
3. Create `index.ts` (`name`, `description`, `pks`, `setup(env)`)
4. Create step files `001-deploy-*.ts`, `002-...`, etc.
5. Create env files `migrations/envs/prod/<your-migration>.env` and `migrations/envs/fork/<your-migration>.env`
6. Optional: add a sh wrapper at `sh/migrate-<your-migration>.sh` and an npm script in root `package.json`

For a new variant of an existing pattern (e.g. `basejump-ethereum` mirroring `basejump-base`): copy the folder, rename, sed `base` → `ethereum`, sed `BASE` → `ETHEREUM`, adjust chain IDs / addresses in env files. Each migration is its own frozen recipe — no shared definitions to keep in sync.

## State files

State path: `deployments/<env>/<migration>.json`. Schema:

```json
{
  "migration": "basejump-base",
  "environment": "prod",
  "startedAt": "2026-03-31T00:48:39.852Z",
  "completedAt": "2026-04-10T03:10:27.537Z",
  "steps": [
    {
      "name": "001-deploy-basejump",
      "status": "completed",
      "output": { "implAddress": "0x...", "proxyAddress": "0x...", "wormholeId": "30" },
      "error": null,
      "startedAt": "...",
      "completedAt": "..."
    }
  ]
}
```

- `status`: `pending` | `completed` | `failed`.
- `output`: flat string→string map, what the step returned.
- Step names must match the migration's NNN-step filenames exactly; mismatch on resume is rejected by the runner.
- Existing steps cannot change between runs — only new steps may be appended. If you need to change an existing step, delete the state file (only on fork; prod state is read-only after renunciation).

## Resume / partial re-run

- **Resume after failure**: just run the same command again. Completed steps are skipped.
- **Force-redo from a step**: `--from <step-name>`. Resets that step and everything after it.
- **Stop early**: `--pause-at <step-name>`. Useful for staged deploys where you want to inspect state between contiguous step groups before continuing.

## Actions

`migrations/actions/` holds chain-agnostic atomic operations — the building blocks that step files compose. Each action takes a wallet + parameters and returns a `StepOutput`. Actions don't know about migrations; migrations import the actions they need.

Action types are imported from `migrations/actions/types.ts`:

- `WalletContext` — `{ publicClient, walletClient, account }` for EVM
- `SolanaContext` — Anchor `{ connection, keypair, wallet, provider, program }` for Solana

## Archived state

`deployments/archive/` holds pre-refactor per-chain state files for historical reference. The merged migration state files at `deployments/prod/<migration>.json` were reconstructed from these. The archive is not consumed by any code — safe to drop once you've verified the merged state files.

---
name: new-migration
description: Scaffold a new migration definition under migrations/definitions/<name>/. Use when the user asks to create a new migration, add a new source chain (e.g. basejump-ethereum mirroring basejump-base), or scaffold migration files following the project's naming convention. Generates types.ts + index.ts + NNN step file stubs ready for the user to fill in.
---

# Scaffold a new migration

Generate a new migration folder under `migrations/definitions/<name>/` that follows the project's conventions (see [CLAUDE.md](../../../CLAUDE.md#naming-conventions) and [migrations/README.md](../../../migrations/README.md)). Step bodies are left as TODO stubs for the user to fill in.

## Step 1 — collect inputs from the user

Ask the user (preferably one batched question with multiple parts):

1. **Migration name** — kebab-case folder name, e.g. `basejump-ethereum`. Will live at `migrations/definitions/<name>/`.
2. **Wallets** — list of `<chain>:<PK_ENV_VAR>` pairs the migration needs. Example: `hydration:PK_LANDING, moonbeam:PK_PROXY, ethereum:PK`. Each chain becomes a key in the `WalletContext` map; each PK env var is declared in the migration's `pks: [...]`.
3. **Steps** — ordered list of step specs. Each spec maps to one NNN-*.ts file. Auto-numbered by position (001, 002, …).
4. **Description** (optional) — one-line description for `index.ts`.

If the user gives a clear spec upfront ("copy basejump-base for ethereum"), don't re-prompt — just confirm the wallet/PK swap (e.g. `base→ethereum`, `RPC_BASE→RPC_ETHEREUM`) and proceed.

## Step spec grammar

| Spec                                      | Phase         | Resulting filename                          |
| ----------------------------------------- | ------------- | ------------------------------------------- |
| `deploy:<contract>`                       | deploy        | `NNN-deploy-<contract>.ts`                  |
| `authorize:<subject>@<contract>`          | authorize     | `NNN-authorize-<subject>@<contract>.ts`     |
| `set:<thing>@<contract>`                  | wire / config | `NNN-set-<thing>@<contract>.ts`             |
| `register:<thing>@<contract>`             | config        | `NNN-register-<thing>@<contract>.ts`        |
| `transfer-ownership@<contract>`           | ownership     | `NNN-transfer-ownership@<contract>.ts`      |
| `renounce@<contract>`                     | ownership     | `NNN-renounce@<contract>.ts`                |

**Ordering rule (enforce this when reviewing the user's step list):**

1. All deploys first (`001…`).
2. Then authorize steps.
3. Then wire steps (`set:<contract>@<contract>` linking deployed addresses).
4. Then config steps (`set:<asset>-…`, `register:<asset>…`).
5. Ownership transfers / renunciations **last**.

If the user's list doesn't follow this order, surface the issue and propose a reordered list before generating.

## Step 2 — validate

- Migration dir must not already exist (`migrations/definitions/<name>/`). If it does, stop and tell the user — never overwrite.
- Every step must parse into the grammar above. Reject ambiguous specs.
- Wallet count must be at least 1.
- PK env var names are conventionally `PK`, `PK_LANDING`, `PK_PROXY`, `PK_EMITTER`, `PK_RELAY` — match existing patterns if possible.

## Step 3 — generate files

Create the migration folder with these files. Use the templates below verbatim — fill in only the variables marked `{{like-this}}`.

### `types.ts`

```ts
import type { wallet } from "@whm/common/evm";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

export interface WalletContext {
  {{#each wallets}}
  {{chain}}: EvmWallet;
  {{/each}}
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
```

For Solana migrations (chain key is `solana`), use `SolanaContext` from `@whm/common/migration` for that key instead of `EvmWallet`. See `migrations/definitions/oracle-relay-solana/types.ts` for the pattern.

### `index.ts`

```ts
import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

const config: MigrationConfig = {
  name: "{{name}}",
  description: "{{description}}",
  pks: [{{#each wallets}}"{{pk}}"{{#unless last}}, {{/unless}}{{/each}}],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      {{#each wallets}}
      {{chain}}: wallet.getWallet(
        required("RPC_{{CHAIN_UPPER}}"),
        Number(required("CHAIN_ID_{{CHAIN_UPPER}}")),
        env.{{pk}} as `0x${string}`,
      ),
      {{/each}}
    };
  },
};

export default config;
```

`{{CHAIN_UPPER}}` = chain name uppercased with `-` replaced by `_`. E.g. `hydration` → `HYDRATION`.

### Each step file (`{{filename}}`)

```ts
import type { MigrationStep } from "./types";

const step: MigrationStep = {
  name: "{{step-name}}",
  description: "TODO: describe {{step-name}}",
  action: async (ctx) => {
    // TODO: implement
    //   - pick wallet via ctx.wallet.<chain>
    //   - read prior deploy outputs via ctx.outputs["NNN-deploy-<contract>"].proxyAddress
    //   - read external addresses via ctx.env.<VAR>
    //   - call the relevant action under migrations/actions/<feature>/
    return {};
  },
};

export default step;
```

## Step 4 — report

After creating the files, print a concise summary:

```
✓ Created migration: migrations/definitions/{{name}}/

Files:
  types.ts  (WalletContext: {{chains-comma-list}})
  index.ts  (pks: {{pks-comma-list}})
  001-…  002-…  003-…   (list each step file generated)

Next:
  1. Implement each NNN-*.ts step's action body.
  2. Create env files:
       migrations/envs/prod/{{name}}.env
       migrations/envs/fork/{{name}}.env
     Required keys per chain: RPC_<CHAIN>, CHAIN_ID_<CHAIN> (+ WORMHOLE_CORE_<CHAIN>, TOKEN_BRIDGE_<CHAIN> as needed).
  3. Set PK env vars: {{pks-comma-list}} (shell or root .env).
  4. (Optional) Add sh/migrate-{{name}}.sh + npm script in root package.json.

Dry-run against fork:
  npx tsx migrations/run.ts --migration {{name}} --env fork
```

## When NOT to use this skill

- The user wants to **add** a step to an existing migration → don't scaffold a new folder; edit `migrations/definitions/<existing>/` directly. Renumber carefully and warn the user that prod state files match step names exactly (mismatch on resume is rejected by the runner).
- The user wants to **modify** an existing step in a renounced/prod migration → that's frozen by design. Surface the renounced-ownership constraint and ask whether they want a new variant migration instead.

## Example invocation

User: "scaffold a basejump-ethereum migration mirroring basejump-base"

Read `migrations/definitions/basejump-base/index.ts` and step file listing to extract the pattern. Propose:

- name: `basejump-ethereum`
- wallets: `hydration:PK_LANDING, moonbeam:PK_PROXY, ethereum:PK`
- steps (16, mirroring basejump-base, with `base` → `ethereum`):
  ```
  deploy:basejump, deploy:proxy, deploy:transactor, deploy:landing,
  authorize:proxy@transactor, authorize:proxy@landing,
  set:transactor@proxy, set:emitter@proxy, set:landing@proxy,
  set:emitter@basejump, set:landing-dest@basejump,
  set:eurc-fee@basejump, set:eurc@landing,
  transfer-ownership@landing, transfer-ownership@proxy, transfer-ownership@basejump
  ```

Confirm with the user, then generate.
